import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { onSessionIdentityMutation } from "./session-accessor.js";
import {
  loadExactSessionEntry,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";

const tempDirs = createTempDirTracker();
const sessionKey = "agent:main:entry-revalidation";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("SQLite session entry patch commit revalidation", () => {
  let env: NodeJS.ProcessEnv;
  let scope: { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };
  let database: ReturnType<typeof openOpenClawAgentDatabase>;

  beforeEach(async () => {
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-entry-revalidation-")),
    };
    scope = { agentId: "main", env, sessionKey };
    await upsertSessionEntryCore(scope, {
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });
    database = openOpenClawAgentDatabase({ agentId: "main", env });
  });

  /** Simulate another writer landing between patch preparation and its commit. */
  function mutateRowOutOfBand(patch: Record<string, string>): void {
    const other = new DatabaseSync(database.path);
    try {
      const entries = Object.entries(patch);
      const setters = entries.map(([key]) => `'$.${key}', ?`).join(", ");
      other
        .prepare(
          `UPDATE session_nodes SET entry_json = json_set(entry_json, ${setters}) WHERE session_key = ?`,
        )
        .run(...entries.map(([, value]) => value), sessionKey);
    } finally {
      other.close();
    }
  }

  it("commits the patch when the persisted row is unchanged since preparation", async () => {
    const persisted = await patchSessionEntryCore(scope, () => ({ model: "gpt-5.6" }));
    expect(persisted).toMatchObject({ model: "gpt-5.6", sessionId: "session-1" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
      model: "gpt-5.6",
      sessionId: "session-1",
    });
  });

  it("rejects the commit when the row changed while the update callback ran", async () => {
    await expect(
      patchSessionEntryCore(scope, () => {
        mutateRowOutOfBand({ model: "gpt-5.7" });
        return { label: "renamed" };
      }),
    ).rejects.toMatchObject({ name: "SqliteSessionMutationConflictError" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({ model: "gpt-5.7" });
    expect(loadExactSessionEntry(scope)?.entry.label).toBeUndefined();
  });

  it("rejects a lifecycle-target patch when the row changed while the update callback ran", async () => {
    await expect(
      patchSessionEntryTarget(
        {
          agentId: scope.agentId,
          storePath: database.path,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        },
        () => {
          mutateRowOutOfBand({ model: "gpt-5.8" });
          return { label: "renamed" };
        },
      ),
    ).rejects.toMatchObject({ name: "SqliteSessionMutationConflictError" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({ model: "gpt-5.8" });
  });

  it("still publishes an identity replacement when a patch rotates the session id", async () => {
    const mutations: unknown[] = [];
    const unsubscribe = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    try {
      await patchSessionEntryCore(scope, () => ({ sessionId: "session-2" }));
    } finally {
      unsubscribe();
    }
    expect(mutations).toContainEqual(
      expect.objectContaining({
        kind: "replace",
        previous: expect.objectContaining({ sessionId: "session-1", sessionKeys: [sessionKey] }),
        current: expect.objectContaining({ sessionId: "session-2", sessionKeys: [sessionKey] }),
      }),
    );
  });

  it("does not publish an identity mutation when a patch keeps the session id", async () => {
    const mutations: unknown[] = [];
    const unsubscribe = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    try {
      await patchSessionEntryCore(scope, () => ({ updatedAt: 20 }));
    } finally {
      unsubscribe();
    }
    expect(mutations).toEqual([]);
  });
});
