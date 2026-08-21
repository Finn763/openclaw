import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const INSTALL_SMOKE = ".github/workflows/install-smoke.yml";
const INSTALL_SMOKE_REUSABLE = ".github/workflows/install-smoke-reusable.yml";
const RELEASE_CHECKS = ".github/workflows/openclaw-release-checks.yml";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: {
      include?: Array<Record<string, unknown>>;
    };
  };
  steps?: WorkflowStep[];
  "timeout-minutes"?: number | string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: {
    schedule?: unknown;
    workflow_call?: { inputs?: Record<string, Record<string, unknown>> };
    workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
  };
  permissions?: Record<string, unknown>;
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const found = workflow.jobs[name];
  expect(found, name).toBeDefined();
  return found!;
}

function step(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const found = workflowJob.steps?.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

describe("install smoke no-push root image transport", () => {
  it("keeps schedule/manual orchestration read-only and delegates to the reusable core", () => {
    const workflow = readWorkflow(INSTALL_SMOKE);
    expect(workflow.on?.schedule).toBeDefined();
    expect(workflow.on?.workflow_dispatch?.inputs).toMatchObject({
      run_bun_global_install_smoke: { default: false, type: "boolean" },
      update_baseline_version: { default: "latest", type: "string" },
    });
    expect(workflow.on?.workflow_call).toBeUndefined();
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
    });

    const delegated = job(workflow, "install_smoke");
    expect(delegated.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
    });
    expect(delegated.uses).toBe("./.github/workflows/install-smoke-reusable.yml");
    expect(delegated.with).toMatchObject({
      allow_unreleased_changelog: true,
      ref: "${{ github.sha }}",
      run_bun_global_install_smoke:
        "${{ github.event_name == 'schedule' || inputs.run_bun_global_install_smoke }}",
      update_baseline_version: "${{ inputs.update_baseline_version || 'latest' }}",
    });
    expect(readFileSync(INSTALL_SMOKE, "utf8")).not.toContain("packages: write");
  });

  it("makes the reusable core artifact-only and rejects registry transport", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    expect(workflow.on?.schedule).toBeUndefined();
    expect(workflow.on?.workflow_dispatch).toBeUndefined();
    expect(workflow.on?.workflow_call?.inputs?.allow_unreleased_changelog).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(workflow.on?.workflow_call?.inputs?.root_image_transport).toBeUndefined();
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
    });

    const preflight = job(workflow, "preflight");
    expect(preflight.outputs?.workflow_repository).toBe(
      "${{ steps.workflow.outputs.workflow_repository }}",
    );
    expect(preflight.outputs?.workflow_sha).toBe("${{ steps.workflow.outputs.workflow_sha }}");
    const workflowIdentity = step(preflight, "Resolve job workflow identity");
    expect(workflowIdentity.env?.JOB_CONTEXT).toBe("${{ toJSON(job) }}");
    expect(workflowIdentity.run).toContain(
      "job.workflow_repository must be an owner/repository slug",
    );
    expect(workflowIdentity.run).toContain("job.workflow_sha must be a full lowercase commit SHA");
    const manifest = step(preflight, "Build install-smoke CI manifest");
    expect(manifest.env).toEqual({
      OPENCLAW_CI_WORKFLOW_BUN_GLOBAL_INSTALL_SMOKE:
        "${{ inputs.run_bun_global_install_smoke || 'false' }}",
    });
    expect(manifest.run).toContain(
      'dockerfile_image="openclaw-dockerfile-smoke-local:${target_sha}"',
    );
    expect(manifest.run).toContain(
      'run_bun_global_install_smoke="$workflow_bun_global_install_smoke"',
    );
    expect(manifest.run).not.toContain("event_name");
    expect(manifest.run).not.toContain("workflow_call");

    const text = readFileSync(INSTALL_SMOKE_REUSABLE, "utf8");
    expect(text).not.toContain("packages: write");
    expect(text).not.toContain("docker/login-action@");
    expect(text).not.toContain("--push");
    expect(workflow.jobs.push_root_dockerfile_image).toBeUndefined();
  });

  it("builds one local target image and uploads provenance-bound bytes", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    const producer = job(workflow, "root_dockerfile_image");
    expect(producer.permissions).toEqual({
      contents: "read",
      packages: "read",
    });
    expect(producer.outputs).toMatchObject({
      archive_sha256: "${{ steps.image_artifact.outputs.archive_sha256 }}",
      artifact_digest: "${{ steps.image_artifact_upload.outputs.artifact-digest }}",
      artifact_id: "${{ steps.image_artifact_upload.outputs.artifact-id }}",
      artifact_name: "${{ steps.image_artifact.outputs.artifact_name }}",
      artifact_run_attempt: "${{ steps.image_artifact.outputs.run_attempt }}",
      artifact_run_id: "${{ steps.image_artifact.outputs.run_id }}",
      image_ref: "${{ steps.image.outputs.image_ref }}",
    });
    expect(producer.outputs?.image_exists).toBeUndefined();
    expect(step(producer, "Checkout CLI").with).toMatchObject({
      ref: "${{ needs.preflight.outputs.target_sha }}",
      "persist-credentials": false,
    });
    expect(step(producer, "Checkout trusted image artifact helper").if).toBeUndefined();

    const localBuild = step(producer, "Build local root Dockerfile smoke image");
    expect(localBuild.if).toBeUndefined();
    expect(localBuild.run).toContain("--load");
    expect(localBuild.run).not.toContain("--push");
    expect(localBuild.run).toContain('-t "$IMAGE_REF"');

    const pack = step(producer, "Pack root Dockerfile image artifact");
    expect(pack.if).toBeUndefined();
    expect(pack.env).toMatchObject({
      IMAGE_REF: "${{ needs.preflight.outputs.dockerfile_image }}",
      TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
      WORKFLOW_SHA: "${{ needs.preflight.outputs.workflow_sha }}",
    });
    expect(pack.run).toContain(
      'artifact_name="install-smoke-root-image-${TARGET_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(pack.run).toContain(
      'pack "$artifact_dir" install-smoke-root "$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"',
    );

    const upload = step(producer, "Upload root Dockerfile image artifact");
    expect(upload.if).toBeUndefined();
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toMatchObject({
      "compression-level": 0,
      "if-no-files-found": "error",
      name: "${{ steps.image_artifact.outputs.artifact_name }}",
      path: "${{ steps.image_artifact.outputs.artifact_path }}",
    });

    const ready = job(workflow, "root_dockerfile_image_ready");
    expect(ready.needs).toEqual(["preflight", "root_dockerfile_image"]);
    const verify = step(ready, "Verify root Dockerfile image preparation");
    expect(verify.env).toEqual({
      PREPARE_RESULT: "${{ needs.root_dockerfile_image.result }}",
    });
    expect(verify.run).toContain('if [[ "$PREPARE_RESULT" != "success" ]]');
    expect(verify.run).not.toContain("PUSH_RESULT");
  });

  it("verifies and loads the immutable artifact in every consumer", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    for (const jobName of [
      "root_dockerfile_smokes",
      "installer_smoke_update",
      "bun_global_install_smoke",
    ]) {
      const consumer = job(workflow, jobName);
      expect(consumer.needs, jobName).toContain("root_dockerfile_image_ready");
      expect(consumer.env?.OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE, jobName).toBe("1");
      expect(step(consumer, "Checkout trusted image artifact helper").if, jobName).toBeUndefined();
      expect(
        consumer.steps?.find((candidate) => candidate.name === "Log in to GHCR"),
        jobName,
      ).toBeUndefined();
      expect(
        consumer.steps?.find((candidate) => candidate.name === "Pull root Dockerfile smoke image"),
        jobName,
      ).toBeUndefined();

      const binding = step(consumer, "Validate root Dockerfile image artifact binding");
      expect(binding.if, jobName).toBeUndefined();
      expect(binding.env, jobName).toMatchObject({
        ARCHIVE_SHA256: "${{ needs.root_dockerfile_image.outputs.archive_sha256 }}",
        ARTIFACT_DIGEST: "${{ needs.root_dockerfile_image.outputs.artifact_digest }}",
        ARTIFACT_ID: "${{ needs.root_dockerfile_image.outputs.artifact_id }}",
        ARTIFACT_NAME: "${{ needs.root_dockerfile_image.outputs.artifact_name }}",
        ARTIFACT_RUN_ATTEMPT: "${{ needs.root_dockerfile_image.outputs.artifact_run_attempt }}",
        ARTIFACT_RUN_ID: "${{ needs.root_dockerfile_image.outputs.artifact_run_id }}",
        GH_TOKEN: "${{ github.token }}",
        TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
      });
      expect(binding.run, jobName).toContain(
        'expected_artifact_name="install-smoke-root-image-${TARGET_SHA:0:12}-${ARTIFACT_RUN_ID}-${ARTIFACT_RUN_ATTEMPT}"',
      );
      expect(binding.run, jobName).toContain('[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]]');
      expect(binding.run, jobName).toContain(
        "bash .release-harness/scripts/docker/shared-image-artifact.sh",
      );
      expect(binding.run, jobName).toContain('verify-upload "Root image"');
      expect(binding.run, jobName).toContain('"$ARTIFACT_RUN_ID" "$ARTIFACT_RUN_ATTEMPT"');
      expect(binding.run, jobName).not.toContain("gh api");
      expect(binding.run, jobName).not.toContain("artifact_json=");
      expect(binding.run, jobName).not.toContain("attempt_json=");
      expect(binding.run, jobName).not.toContain("<<<");

      const download = step(consumer, "Download root Dockerfile image artifact");
      expect(download.if, jobName).toBeUndefined();
      expect(download.with, jobName).toMatchObject({
        "artifact-ids": "${{ needs.root_dockerfile_image.outputs.artifact_id }}",
        "github-token": "${{ github.token }}",
        path: "${{ runner.temp }}/install-smoke-root-image",
        "run-id": "${{ needs.root_dockerfile_image.outputs.artifact_run_id }}",
      });

      const load = step(consumer, "Verify and load root Dockerfile image artifact");
      expect(load.if, jobName).toBeUndefined();
      expect(load.run, jobName).toContain(
        'load "${RUNNER_TEMP}/install-smoke-root-image" install-smoke-root',
      );
      expect(load.run, jobName).toContain('"$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"');

      const requireLocal = step(consumer, "Require local root Dockerfile image");
      expect(requireLocal.if, jobName).toBeUndefined();
      expect(requireLocal.run, jobName).toBe('docker image inspect "$IMAGE_REF" >/dev/null');
    }

    const text = readFileSync(INSTALL_SMOKE_REUSABLE, "utf8");
    expect(text.match(/verify-upload "Root image"/g)).toHaveLength(3);
    expect(text).not.toContain("gh api");
  });

  it("binds independent installer producer-consumer pairs to immutable artifact tuples", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    const pairs = [
      {
        artifactKind: "install-smoke-update",
        artifactPrefix: "install-smoke-update-image",
        buildName: "Build installer smoke image",
        consumerName: "installer_smoke_update",
        downloadName: "Download installer update image artifact",
        group: "update",
        loadName: "Verify and load installer update image artifact",
        packName: "Pack installer smoke image artifact",
        producerName: "installer_smoke_update_image",
        setupName: "Setup Node environment for installer update smoke",
        testName: "Run installer update docker tests",
        uploadName: "Upload installer smoke image artifact",
        validateName: "Validate installer update image artifact binding",
      },
      {
        artifactKind: "install-smoke-nonroot",
        artifactPrefix: "install-smoke-nonroot-image",
        buildName: "Build installer non-root image",
        consumerName: "installer_smoke_nonroot",
        downloadName: "Download installer non-root image artifact",
        group: "nonroot",
        loadName: "Verify and load installer non-root image artifact",
        packName: "Pack installer non-root image artifact",
        producerName: "installer_smoke_nonroot_image",
        setupName: "Setup Node environment for installer non-root smoke",
        testName: "Run installer non-root docker tests",
        uploadName: "Upload installer non-root image artifact",
        validateName: "Validate installer non-root image artifact binding",
      },
    ] as const;

    for (const pair of pairs) {
      const producer = job(workflow, pair.producerName);
      expect(producer.needs, pair.producerName).toEqual(["preflight"]);
      expect(producer["timeout-minutes"], pair.producerName).toBe(45);
      expect(producer.outputs, pair.producerName).toEqual({
        archive_sha256: "${{ steps.image_artifact.outputs.archive_sha256 }}",
        artifact_digest: "${{ steps.image_artifact_upload.outputs.artifact-digest }}",
        artifact_id: "${{ steps.image_artifact_upload.outputs.artifact-id }}",
        artifact_name: "${{ steps.image_artifact.outputs.artifact_name }}",
        artifact_run_attempt: "${{ steps.image_artifact.outputs.run_attempt }}",
        artifact_run_id: "${{ steps.image_artifact.outputs.run_id }}",
        target_sha: "${{ steps.image_artifact.outputs.target_sha }}",
        workflow_sha: "${{ steps.image_artifact.outputs.workflow_sha }}",
      });
      expect(step(producer, pair.buildName).run, pair.producerName).toContain("--load");

      const pack = step(producer, pair.packName);
      expect(pack.run, pair.producerName).toContain(
        `artifact_name="${pair.artifactPrefix}-\${TARGET_SHA}-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}"`,
      );
      expect(pack.run, pair.producerName).toContain(
        `pack "$artifact_dir" ${pair.artifactKind} "$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"`,
      );
      expect(pack.run, pair.producerName).toContain('echo "archive_sha256=$archive_sha256"');
      expect(pack.run, pair.producerName).toContain('echo "run_attempt=$GITHUB_RUN_ATTEMPT"');
      expect(pack.run, pair.producerName).toContain('echo "run_id=$GITHUB_RUN_ID"');
      expect(pack.run, pair.producerName).toContain('echo "target_sha=$TARGET_SHA"');
      expect(pack.run, pair.producerName).toContain('echo "workflow_sha=$WORKFLOW_SHA"');
      expect(step(producer, pair.uploadName).with, pair.producerName).toMatchObject({
        "compression-level": 0,
        "if-no-files-found": "error",
        name: "${{ steps.image_artifact.outputs.artifact_name }}",
      });

      const consumer = job(workflow, pair.consumerName);
      const expectedNeeds =
        pair.group === "update"
          ? ["preflight", "root_dockerfile_image", "root_dockerfile_image_ready", pair.producerName]
          : ["preflight", pair.producerName];
      expect(consumer.needs, pair.consumerName).toEqual(expectedNeeds);
      expect(consumer["timeout-minutes"], pair.consumerName).toBe(
        pair.group === "update" ? 120 : 60,
      );

      const binding = step(consumer, pair.validateName);
      expect(binding.env, pair.consumerName).toMatchObject({
        ARCHIVE_SHA256: `\${{ needs.${pair.producerName}.outputs.archive_sha256 }}`,
        ARTIFACT_DIGEST: `\${{ needs.${pair.producerName}.outputs.artifact_digest }}`,
        ARTIFACT_ID: `\${{ needs.${pair.producerName}.outputs.artifact_id }}`,
        ARTIFACT_NAME: `\${{ needs.${pair.producerName}.outputs.artifact_name }}`,
        ARTIFACT_RUN_ATTEMPT: `\${{ needs.${pair.producerName}.outputs.artifact_run_attempt }}`,
        ARTIFACT_RUN_ID: `\${{ needs.${pair.producerName}.outputs.artifact_run_id }}`,
        ARTIFACT_TARGET_SHA: `\${{ needs.${pair.producerName}.outputs.target_sha }}`,
        ARTIFACT_WORKFLOW_SHA: `\${{ needs.${pair.producerName}.outputs.workflow_sha }}`,
        TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
        WORKFLOW_SHA: "${{ needs.preflight.outputs.workflow_sha }}",
      });
      expect(binding.run, pair.consumerName).toContain('[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]');
      expect(binding.run, pair.consumerName).toContain(
        '[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]',
      );
      expect(binding.run, pair.consumerName).toContain('[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]]');
      expect(binding.run, pair.consumerName).toContain(
        '[[ "$ARTIFACT_TARGET_SHA" == "$TARGET_SHA" ]]',
      );
      expect(binding.run, pair.consumerName).toContain(
        '[[ "$ARTIFACT_WORKFLOW_SHA" == "$WORKFLOW_SHA" ]]',
      );
      expect(binding.run, pair.consumerName).toContain(
        `expected_artifact_name="${pair.artifactPrefix}-\${TARGET_SHA}-\${ARTIFACT_RUN_ID}-\${ARTIFACT_RUN_ATTEMPT}"`,
      );
      expect(binding.run, pair.consumerName).toContain("verify-upload");

      const download = step(consumer, pair.downloadName);
      expect(download.with, pair.consumerName).toMatchObject({
        "artifact-ids": `\${{ needs.${pair.producerName}.outputs.artifact_id }}`,
        "github-token": "${{ github.token }}",
        "run-id": `\${{ needs.${pair.producerName}.outputs.artifact_run_id }}`,
      });
      expect(download.with?.name, pair.consumerName).toBeUndefined();

      const load = step(consumer, pair.loadName);
      expect(load.env, pair.consumerName).toMatchObject({
        OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256: `\${{ needs.${pair.producerName}.outputs.archive_sha256 }}`,
        OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT: `\${{ needs.${pair.producerName}.outputs.artifact_run_attempt }}`,
        OPENCLAW_SHARED_IMAGE_RUN_ID: `\${{ needs.${pair.producerName}.outputs.artifact_run_id }}`,
        TARGET_SHA: `\${{ needs.${pair.producerName}.outputs.target_sha }}`,
        WORKFLOW_SHA: `\${{ needs.${pair.producerName}.outputs.workflow_sha }}`,
      });
      expect(load.run, pair.consumerName).toContain(
        `load "\${RUNNER_TEMP}/${pair.artifactPrefix}" ${pair.artifactKind}`,
      );

      const setup = step(consumer, pair.setupName);
      expect(setup.with, pair.consumerName).toMatchObject({
        "install-bun": "false",
        "install-deps": pair.group === "update" ? "true" : "false",
        "save-actions-cache": "false",
        "use-actions-cache": pair.group === "update" ? "true" : "false",
      });
      expect(step(consumer, pair.testName).env?.OPENCLAW_INSTALL_SMOKE_GROUP).toBe(pair.group);
    }
  });

  it("drains every independent producer and consumer without sibling failure suppression", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    const update = job(workflow, "installer_smoke_update");
    const nonroot = job(workflow, "installer_smoke_nonroot");
    const aggregate = job(workflow, "installer_smoke");

    expect(update.needs).toEqual([
      "preflight",
      "root_dockerfile_image",
      "root_dockerfile_image_ready",
      "installer_smoke_update_image",
    ]);
    expect(update.needs).not.toContain("installer_smoke_nonroot_image");
    expect(nonroot.needs).toEqual(["preflight", "installer_smoke_nonroot_image"]);
    expect(nonroot.needs).not.toContain("root_dockerfile_image");
    expect(nonroot.needs).not.toContain("root_dockerfile_image_ready");
    expect(nonroot.needs).not.toContain("installer_smoke_update_image");

    expect(aggregate.if).toContain("always()");
    expect(aggregate.needs).toEqual([
      "preflight",
      "root_dockerfile_image",
      "root_dockerfile_image_ready",
      "installer_smoke_update_image",
      "installer_smoke_update",
      "installer_smoke_nonroot_image",
      "installer_smoke_nonroot",
    ]);
    expect(aggregate["timeout-minutes"]).toBe(5);
    const verify = step(aggregate, "Verify installer smoke groups");
    expect(verify.env).toEqual({
      NONROOT_CONSUMER_RESULT: "${{ needs.installer_smoke_nonroot.result }}",
      NONROOT_PRODUCER_RESULT: "${{ needs.installer_smoke_nonroot_image.result }}",
      ROOT_IMAGE_READY_RESULT: "${{ needs.root_dockerfile_image_ready.result }}",
      ROOT_IMAGE_RESULT: "${{ needs.root_dockerfile_image.result }}",
      UPDATE_CONSUMER_RESULT: "${{ needs.installer_smoke_update.result }}",
      UPDATE_PRODUCER_RESULT: "${{ needs.installer_smoke_update_image.result }}",
    });
    for (const result of [
      "ROOT_IMAGE_RESULT",
      "ROOT_IMAGE_READY_RESULT",
      "UPDATE_PRODUCER_RESULT",
      "UPDATE_CONSUMER_RESULT",
      "NONROOT_PRODUCER_RESULT",
      "NONROOT_CONSUMER_RESULT",
    ]) {
      expect(verify.run).toContain(`"$${result}"`);
    }
  });

  it("selects the read-only reusable core from release checks", () => {
    const release = readWorkflow(RELEASE_CHECKS);
    const caller = job(release, "install_smoke_release_checks");
    expect(caller.uses).toBe("./.github/workflows/install-smoke-reusable.yml");
    expect(caller.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
    });
    expect(caller.with).toMatchObject({
      allow_unreleased_changelog:
        "${{ needs.resolve_target.outputs.allow_unreleased_changelog == 'true' }}",
      ref: "${{ needs.resolve_target.outputs.revision }}",
      run_bun_global_install_smoke: true,
    });
  });

  it("passes package changelog intent only to current-tree smoke scripts", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    expect(
      step(job(workflow, "installer_smoke_update"), "Run installer update docker tests").env,
    ).toMatchObject({
      OPENCLAW_INSTALL_SMOKE_ALLOW_UNRELEASED_CHANGELOG: "${{ inputs.allow_unreleased_changelog }}",
    });
    expect(
      step(job(workflow, "bun_global_install_smoke"), "Run Bun global install image-provider smoke")
        .env,
    ).toMatchObject({
      OPENCLAW_BUN_GLOBAL_SMOKE_ALLOW_UNRELEASED_CHANGELOG:
        "${{ inputs.allow_unreleased_changelog }}",
    });
  });
});
