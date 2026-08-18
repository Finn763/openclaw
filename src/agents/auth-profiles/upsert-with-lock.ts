/** Locked auth profile writes and attempt-scoped compensation. */
import { isDeepStrictEqual } from "node:util";
import { AUTH_STORE_VERSION } from "./constants.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  deletePersistedAuthProfileStoreRaw,
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
} from "./sqlite.js";
import { buildPersistedAuthProfileState } from "./state.js";
import {
  resolvePersistedAuthProfileOwnerAgentDir,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore, ProfileUsageStats } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";

type AuthProfileUpsertParams = Parameters<typeof upsertAuthProfileWithLock>[0];

function throwAuthProfileUpdateError(): never {
  throw new Error(
    "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
  );
}

async function upsertAuthProfileWithLockCore(
  params: AuthProfileUpsertParams,
  resetFailureState: boolean,
): Promise<AuthProfileStore | null> {
  const credential = normalizeAuthProfileCredential(params.credential);
  const agentDir = resetFailureState
    ? resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        profileId: params.profileId,
        stateDir: params.stateDir,
      })
    : params.agentDir;
  return await updateAuthProfileStoreWithLock({
    agentDir,
    stateDir: params.stateDir,
    saveOptions: {
      filterExternalAuthProfiles: false,
      ...(resetFailureState ? { preserveStateProfileIds: [params.profileId] } : {}),
      syncExternalCli: false,
    },
    updater: (store) => {
      store.profiles[params.profileId] = credential;
      if (resetFailureState) {
        store.usageStats = store.usageStats ?? {};
        const existingStats = store.usageStats[params.profileId];
        const credentialGeneration = (existingStats?.credentialGeneration ?? 0) + 1;
        if (!Number.isSafeInteger(credentialGeneration)) {
          throw new RangeError("Auth profile credential generation exhausted safe integer range");
        }
        store.usageStats[params.profileId] = resetAuthProfileFailureState(existingStats, {
          credentialGeneration,
        });
      }
      return true;
    },
  });
}

type PersistAuthProfileBatchParams = {
  profiles: readonly {
    profileId: string;
    credential: AuthProfileCredential;
    replaceExisting?: boolean;
    resetFailureState?: boolean;
  }[];
  order?: Readonly<Record<string, readonly string[]>>;
  agentDir?: string;
  stateDir?: string;
};

type PersistAuthProfileBatchReceipt = { rollback: () => void };

function resolveBatchOrder(
  order: PersistAuthProfileBatchParams["order"],
  profileIds: ReadonlySet<string>,
): PersistAuthProfileBatchParams["order"] {
  if (!order) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(order)
      .map(([provider, ids]) => [provider, ids.filter((id) => profileIds.has(id))] as const)
      .filter(([, ids]) => ids.length > 0),
  );
}

/** Atomically persists a batch and returns conditional attempt-scoped compensation. */
export async function persistAuthProfileBatch(
  params: PersistAuthProfileBatchParams,
): Promise<PersistAuthProfileBatchReceipt> {
  const dedupedProfiles = [
    ...new Map(params.profiles.map((entry) => [entry.profileId, entry])).values(),
  ];
  if (dedupedProfiles.length === 0) {
    return { rollback() {} };
  }

  const groups = new Map<string | undefined, typeof dedupedProfiles>();
  for (const entry of dedupedProfiles) {
    const ownerAgentDir = entry.resetFailureState
      ? resolvePersistedAuthProfileOwnerAgentDir({
          agentDir: params.agentDir,
          profileId: entry.profileId,
          stateDir: params.stateDir,
        })
      : params.agentDir;
    const group = groups.get(ownerAgentDir) ?? [];
    group.push(entry);
    groups.set(ownerAgentDir, group);
  }

  const receipts: PersistAuthProfileBatchReceipt[] = [];
  try {
    for (const [agentDir, profiles] of groups) {
      const profileIds = new Set(profiles.map((entry) => entry.profileId));
      receipts.push(
        await persistAuthProfileBatchForAgent({
          ...params,
          profiles,
          agentDir,
          order: resolveBatchOrder(params.order, profileIds),
        }),
      );
    }
  } catch (error) {
    for (const receipt of receipts.toReversed()) {
      receipt.rollback();
    }
    throw error;
  }

  return {
    rollback: () => {
      for (const receipt of receipts.toReversed()) {
        receipt.rollback();
      }
    },
  };
}

async function persistAuthProfileBatchForAgent(
  params: PersistAuthProfileBatchParams,
): Promise<PersistAuthProfileBatchReceipt> {
  const profiles = new Map(
    params.profiles.map(({ profileId, credential, replaceExisting, resetFailureState }) => [
      profileId,
      {
        credential: normalizeAuthProfileCredential(credential),
        replaceExisting: replaceExisting !== false,
        resetFailureState: resetFailureState === true,
      },
    ]),
  );

  const previousProfiles = new Map<string, AuthProfileCredential | undefined>();
  const previousUsageStats = new Map<string, ProfileUsageStats | undefined>();
  const previousOrder = new Map<string, readonly string[] | undefined>();
  const appliedProfiles = new Map<string, AuthProfileCredential>();
  const appliedUsageStats = new Map<string, ProfileUsageStats>();
  let storeWasAbsent = false;
  let stateWasAbsent = false;
  runAuthProfileWriteTransaction(
    params.agentDir,
    (database) => {
      storeWasAbsent =
        inspectPersistedAuthProfileStoreRaw(params.agentDir, database).status === "missing";
      stateWasAbsent =
        inspectPersistedAuthProfileStateRaw(params.agentDir, database).status === "missing";
      const next =
        loadPersistedAuthProfileStore(params.agentDir, { database }) ??
        ({ version: AUTH_STORE_VERSION, profiles: {} } satisfies AuthProfileStore);
      for (const [profileId, entry] of profiles) {
        if (!entry.replaceExisting && Object.hasOwn(next.profiles, profileId)) {
          continue;
        }
        previousProfiles.set(profileId, next.profiles[profileId]);
        next.profiles[profileId] = entry.credential;
        appliedProfiles.set(profileId, entry.credential);
        if (entry.resetFailureState) {
          const previousStats = next.usageStats?.[profileId];
          previousUsageStats.set(
            profileId,
            previousStats
              ? {
                  ...previousStats,
                  failureCounts: previousStats.failureCounts
                    ? { ...previousStats.failureCounts }
                    : undefined,
                }
              : undefined,
          );
          const credentialGeneration = (previousStats?.credentialGeneration ?? 0) + 1;
          if (!Number.isSafeInteger(credentialGeneration)) {
            throw new RangeError("Auth profile credential generation exhausted safe integer range");
          }
          const resetStats = resetAuthProfileFailureState(previousStats, { credentialGeneration });
          next.usageStats = next.usageStats ?? {};
          next.usageStats[profileId] = resetStats;
          appliedUsageStats.set(profileId, resetStats);
        }
      }
      for (const [provider, profileIds] of Object.entries(params.order ?? {})) {
        previousOrder.set(provider, next.order?.[provider]);
        const existing = next.order?.[provider] ?? [];
        const additions = [...new Set(profileIds)].filter(
          (profileId) => appliedProfiles.has(profileId) && !existing.includes(profileId),
        );
        if (additions.length > 0) {
          next.order = { ...next.order, [provider]: [...existing, ...additions] };
        }
      }
      if (appliedProfiles.size > 0) {
        saveAuthProfileStore(
          next,
          params.agentDir,
          {
            filterExternalAuthProfiles: false,
            preserveStateProfileIds: appliedUsageStats.keys(),
            syncExternalCli: false,
          },
          database,
        );
      }
    },
    { stateDir: params.stateDir },
  );

  let rolledBack = false;
  return {
    rollback: () => {
      if (rolledBack) {
        return;
      }
      runAuthProfileWriteTransaction(
        params.agentDir,
        (database) => {
          const current = loadPersistedAuthProfileStore(params.agentDir, { database });
          if (!current) {
            return;
          }
          const ownedProfiles = new Set<string>();
          for (const [profileId, credential] of appliedProfiles) {
            if (!isDeepStrictEqual(current.profiles[profileId], credential)) {
              continue;
            }
            ownedProfiles.add(profileId);
            const previous = previousProfiles.get(profileId);
            if (previous) {
              current.profiles[profileId] = previous;
            } else {
              delete current.profiles[profileId];
            }
            const appliedStats = appliedUsageStats.get(profileId);
            if (appliedStats && isDeepStrictEqual(current.usageStats?.[profileId], appliedStats)) {
              const previousStats = previousUsageStats.get(profileId);
              current.usageStats = current.usageStats ?? {};
              if (previousStats) {
                current.usageStats[profileId] = previousStats;
              } else {
                delete current.usageStats[profileId];
                if (Object.keys(current.usageStats).length === 0) {
                  delete current.usageStats;
                }
              }
            }
          }
          for (const [provider, profileIds] of Object.entries(params.order ?? {})) {
            const existing = current.order?.[provider];
            if (!existing) {
              continue;
            }
            const preexisting = new Set(previousOrder.get(provider) ?? []);
            const introduced = new Set(
              profileIds.filter((profileId) => !preexisting.has(profileId)),
            );
            const remaining = existing.filter(
              (profileId) => !introduced.has(profileId) || !ownedProfiles.has(profileId),
            );
            if (remaining.length === existing.length) {
              continue;
            }
            if (remaining.length > 0) {
              current.order = { ...current.order, [provider]: remaining };
            } else if (current.order) {
              delete current.order[provider];
              if (Object.keys(current.order).length === 0) {
                delete current.order;
              }
            }
          }
          saveAuthProfileStore(
            current,
            params.agentDir,
            {
              filterExternalAuthProfiles: false,
              preserveStateProfileIds: previousUsageStats.keys(),
              syncExternalCli: false,
            },
            database,
          );
          if (storeWasAbsent && Object.keys(current.profiles).length === 0) {
            deletePersistedAuthProfileStoreRaw(params.agentDir, database);
          }
          if (stateWasAbsent && buildPersistedAuthProfileState(current) === null) {
            writePersistedAuthProfileStateRaw(null, params.agentDir, database);
          }
        },
        { stateDir: params.stateDir },
      );
      rolledBack = true;
    },
  };
}

/** Upserts an auth profile under the store lock, returning null on store write failure. */
export async function upsertAuthProfileWithLock(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
  stateDir?: string;
}): Promise<AuthProfileStore | null> {
  return await upsertAuthProfileWithLockCore(params, false);
}

/** Upserts an auth profile under the store lock, failing when the store cannot be written. */
export async function upsertAuthProfileWithLockOrThrow(
  params: Parameters<typeof upsertAuthProfileWithLock>[0],
): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throwAuthProfileUpdateError();
  }
}

/** Atomically persists a completed login and clears failure state from the replaced credential. */
export async function upsertAuthProfileAfterLoginWithLock(
  params: AuthProfileUpsertParams,
): Promise<AuthProfileStore | null> {
  return await upsertAuthProfileWithLockCore(params, true);
}

/** Atomically persists a completed login and fails when the store cannot be written. */
export async function upsertAuthProfileAfterLoginWithLockOrThrow(
  params: AuthProfileUpsertParams,
): Promise<void> {
  const updated = await upsertAuthProfileAfterLoginWithLock(params);
  if (!updated) {
    throwAuthProfileUpdateError();
  }
}
