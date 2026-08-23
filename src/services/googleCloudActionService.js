import { createHash } from "node:crypto";

import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import { executeAuditedWriteAction } from "./permissionService.js";
import { resolveFirestoreProjectId } from "../config/memoryBackend.js";

const RESOURCE_MANAGER_API =
  "https://cloudresourcemanager.googleapis.com/v1";
const CLOUD_RUN_API = "https://run.googleapis.com/apis/serving.knative.dev/v1";
const CLOUD_BUILD_API = "https://cloudbuild.googleapis.com/v1";
const DEFAULT_REGION = "europe-west1";
const DEFAULT_SERVICE = "synchron-backend-google";
const DEFAULT_CLOUD_BUILD_LOCATION = "global";
const DEFAULT_CLOUD_BUILD_TRIGGER_ID =
  "d943b5bc-a267-4273-a48a-3c750f484a42";
const DEFAULT_CLOUD_BUILD_TRIGGER_NAME = "synchron-main-deploy";
const SAFE_SHA_PATTERN = /^[a-f0-9]{40}$/iu;
const SAFE_TRIGGER_ID_PATTERN = /^[a-z0-9-]{8,128}$/iu;
const PROJECT_ROLE_PATTERN =
  /^(?:roles\/[A-Za-z0-9_.-]+|projects\/[A-Za-z0-9-]+\/roles\/[A-Za-z0-9_.-]+)$/u;
const PRINCIPAL_PATTERN =
  /^(?:user|serviceAccount|group|domain):[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u;
const SERVICE_ACCOUNT_PATTERN =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,61}[a-z0-9]\.iam\.gserviceaccount\.com$/u;

const ACTIONS = Object.freeze({
  GRANT_PROJECT_ROLE: "infrastructure.write:grant_project_role",
  REVOKE_PROJECT_ROLE: "infrastructure.write:revoke_project_role",
  UPDATE_CLOUD_RUN_SERVICE_ACCOUNT:
    "infrastructure.write:update_cloud_run_service_account",
  RUN_CLOUD_BUILD_TRIGGER: "infrastructure.write:run_cloud_build_trigger",
});

const OPERATION_ACTIONS = Object.freeze({
  grant_project_role: ACTIONS.GRANT_PROJECT_ROLE,
  revoke_project_role: ACTIONS.REVOKE_PROJECT_ROLE,
  update_cloud_run_service_account: ACTIONS.UPDATE_CLOUD_RUN_SERVICE_ACCOUNT,
  run_cloud_build_trigger: ACTIONS.RUN_CLOUD_BUILD_TRIGGER,
});

export class GoogleCloudActionError extends Error {
  constructor(message, status = 400, code = "GOOGLE_CLOUD_ACTION_INVALID") {
    super(message);
    this.name = "GoogleCloudActionError";
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, maxLength, label, { required = false } = {}) {
  const clean =
    typeof value === "string"
      ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim()
      : "";
  if ((required && !clean) || clean.length > maxLength) {
    throw new GoogleCloudActionError(
      `Липсва валидно поле „${label}“.`,
      400,
      "GOOGLE_CLOUD_ACTION_FIELD_INVALID",
    );
  }
  return clean;
}

function projectIdFromEnvironment(env = process.env) {
  const projectId = cleanText(resolveFirestoreProjectId(env), 80, "projectId", {
    required: true,
  });
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(projectId)) {
    throw new GoogleCloudActionError(
      "Google Cloud project ID е невалиден.",
      400,
      "GOOGLE_CLOUD_PROJECT_INVALID",
    );
  }
  return projectId;
}

function fingerprint(label, value) {
  return createHash("sha256")
    .update(`${label}\0`)
    .update(cleanText(value, 400, label, { required: true }))
    .digest("hex");
}

function normalizePrincipal(value) {
  const principal = cleanText(value, 320, "principal", { required: true });
  if (!PRINCIPAL_PATTERN.test(principal)) {
    throw new GoogleCloudActionError(
      "Principal трябва да е user:, serviceAccount:, group: или domain: адрес.",
      400,
      "GOOGLE_CLOUD_PRINCIPAL_INVALID",
    );
  }
  return principal;
}

function normalizeRole(value) {
  const role = cleanText(value, 200, "role", { required: true });
  if (!PROJECT_ROLE_PATTERN.test(role)) {
    throw new GoogleCloudActionError(
      "Google Cloud role трябва да е predefined или project custom role.",
      400,
      "GOOGLE_CLOUD_ROLE_INVALID",
    );
  }
  return role;
}

function normalizeServiceAccount(value) {
  const serviceAccount = cleanText(value, 320, "serviceAccount", {
    required: true,
  });
  if (!SERVICE_ACCOUNT_PATTERN.test(serviceAccount)) {
    throw new GoogleCloudActionError(
      "Cloud Run service account е невалиден.",
      400,
      "GOOGLE_CLOUD_SERVICE_ACCOUNT_INVALID",
    );
  }
  return serviceAccount;
}

function normalizeCloudRunTarget(input = {}, env = process.env) {
  const projectId = projectIdFromEnvironment(env);
  const configuredService = cleanText(
    env.CLOUD_RUN_SERVICE || env.K_SERVICE || DEFAULT_SERVICE,
    80,
    "serviceName",
    { required: true },
  );
  const serviceName = cleanText(input.serviceName || configuredService, 80, "serviceName", {
    required: true,
  });
  const region = cleanText(
    input.region || env.GOOGLE_CLOUD_REGION || env.GCP_REGION || DEFAULT_REGION,
    40,
    "region",
    { required: true },
  );
  if (serviceName !== configuredService) {
    throw new GoogleCloudActionError(
      "Cloud Run промяната е ограничена до текущата AI CORE услуга.",
      403,
      "GOOGLE_CLOUD_SERVICE_PROTECTED",
    );
  }
  if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/u.test(serviceName)) {
    throw new GoogleCloudActionError(
      "Cloud Run service name е невалиден.",
      400,
      "GOOGLE_CLOUD_SERVICE_INVALID",
    );
  }
  if (!/^[a-z0-9-]+$/u.test(region)) {
    throw new GoogleCloudActionError(
      "Cloud Run region е невалиден.",
      400,
      "GOOGLE_CLOUD_REGION_INVALID",
    );
  }
  return { projectId, serviceName, region };
}

function normalizeCloudBuildTarget(input = {}, env = process.env) {
  const projectId = projectIdFromEnvironment(env);
  const triggerId = cleanText(
    input.triggerId || env.CLOUD_BUILD_TRIGGER_ID || DEFAULT_CLOUD_BUILD_TRIGGER_ID,
    128,
    "triggerId",
    { required: true },
  );
  if (!SAFE_TRIGGER_ID_PATTERN.test(triggerId)) {
    throw new GoogleCloudActionError(
      "Cloud Build trigger ID е невалиден.",
      400,
      "GOOGLE_CLOUD_TRIGGER_INVALID",
    );
  }
  const location = cleanText(
    input.location ||
      env.CLOUD_BUILD_TRIGGER_LOCATION ||
      DEFAULT_CLOUD_BUILD_LOCATION,
    40,
    "location",
    { required: true },
  );
  if (location !== DEFAULT_CLOUD_BUILD_LOCATION) {
    throw new GoogleCloudActionError(
      "Cloud Build промяната е ограничена до global trigger-а на AI CORE.",
      403,
      "GOOGLE_CLOUD_TRIGGER_PROTECTED",
    );
  }
  const triggerName = cleanText(
    input.triggerName ||
      env.CLOUD_BUILD_TRIGGER_NAME ||
      DEFAULT_CLOUD_BUILD_TRIGGER_NAME,
    160,
    "triggerName",
    { required: true },
  );
  if (triggerName !== DEFAULT_CLOUD_BUILD_TRIGGER_NAME) {
    throw new GoogleCloudActionError(
      "Cloud Build промяната е ограничена до synchron-main-deploy.",
      403,
      "GOOGLE_CLOUD_TRIGGER_PROTECTED",
    );
  }
  const branch = cleanText(input.branch || "main", 200, "branch", {
    required: true,
  });
  if (branch !== "main") {
    throw new GoogleCloudActionError(
      "Cloud Build deploy capability може да стартира само main.",
      403,
      "GOOGLE_CLOUD_TRIGGER_BRANCH_PROTECTED",
    );
  }
  const commitSha = cleanText(input.commitSha, 40, "commitSha", {
    required: true,
  }).toLowerCase();
  if (!SAFE_SHA_PATTERN.test(commitSha)) {
    throw new GoogleCloudActionError(
      "Cloud Build commit SHA трябва да е точен 40-символен SHA.",
      400,
      "GOOGLE_CLOUD_COMMIT_SHA_INVALID",
    );
  }
  return { projectId, location, triggerId, triggerName, branch, commitSha };
}

function normalizeOperation(operation, input = {}, env = process.env) {
  const action = OPERATION_ACTIONS[operation];
  if (!action) {
    throw new GoogleCloudActionError(
      "Неподдържана Google Cloud промяна.",
      400,
      "GOOGLE_CLOUD_OPERATION_INVALID",
    );
  }
  const projectId = projectIdFromEnvironment(env);

  if (operation === "grant_project_role" || operation === "revoke_project_role") {
    return {
      action,
      resource: {
        projectId,
        principal: normalizePrincipal(input.principal),
        role: normalizeRole(input.role),
      },
      params: {},
    };
  }

  if (operation === "run_cloud_build_trigger") {
    const target = normalizeCloudBuildTarget(input, env);
    return {
      action,
      resource: target,
      params: {},
    };
  }

  const target = normalizeCloudRunTarget(input, env);
  const serviceAccount = normalizeServiceAccount(input.serviceAccount);
  if (!serviceAccount.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
    throw new GoogleCloudActionError(
      "Cloud Run service account трябва да е от текущия project.",
      403,
      "GOOGLE_CLOUD_SERVICE_ACCOUNT_PROJECT_MISMATCH",
    );
  }
  return {
    action,
    resource: target,
    params: { serviceAccount },
  };
}

function assertOwner(ownerId) {
  return fingerprint("owner", ownerId);
}

export async function prepareGoogleCloudAction(
  { ownerId, sessionId, operation, input, env = process.env } = {},
  { createConfirmation = createDurableConfirmation } = {},
) {
  const normalized = normalizeOperation(operation, input, env);
  const confirmation = await createConfirmation({
    sessionId,
    action: normalized.action,
    resource: {
      ...normalized.resource,
      ownerFingerprint: assertOwner(ownerId),
    },
    params: normalized.params,
  });
  return Object.freeze({
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    operation,
    resource: Object.freeze({ ...normalized.resource }),
    params: Object.freeze({ ...normalized.params }),
  });
}

async function metadataAccessToken(fetchImpl = fetch) {
  const response = await fetchImpl(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) {
    throw new GoogleCloudActionError(
      "Google Cloud runtime service identity не върна access token.",
      503,
      "GOOGLE_CLOUD_TOKEN_UNAVAILABLE",
    );
  }
  const data = await response.json();
  if (!data?.access_token) {
    throw new GoogleCloudActionError(
      "Google Cloud runtime service identity не върна валиден access token.",
      503,
      "GOOGLE_CLOUD_TOKEN_INVALID",
    );
  }
  return data.access_token;
}

async function googleJsonRequest(
  url,
  { method = "GET", body, fetchImpl = fetch } = {},
) {
  const token = await metadataAccessToken(fetchImpl);
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new GoogleCloudActionError(
      `Google Cloud API върна HTTP ${response.status}.`,
      response.status,
      payload?.error?.status || "GOOGLE_CLOUD_API_FAILED",
    );
  }
  return payload || {};
}

async function getProjectIamPolicy(projectId, fetchImpl) {
  return googleJsonRequest(
    `${RESOURCE_MANAGER_API}/projects/${encodeURIComponent(projectId)}:getIamPolicy`,
    {
      method: "POST",
      body: { options: { requestedPolicyVersion: 3 } },
      fetchImpl,
    },
  );
}

async function setProjectIamPolicy(projectId, policy, fetchImpl) {
  return googleJsonRequest(
    `${RESOURCE_MANAGER_API}/projects/${encodeURIComponent(projectId)}:setIamPolicy`,
    {
      method: "POST",
      body: { policy, updateMask: { paths: ["bindings", "etag"] } },
      fetchImpl,
    },
  );
}

function cloneBindings(policy) {
  return Array.isArray(policy?.bindings)
    ? policy.bindings.map((binding) => ({
        ...binding,
        members: Array.isArray(binding.members) ? [...binding.members] : [],
      }))
    : [];
}

async function changeProjectRole({ projectId, principal, role, grant, fetchImpl }) {
  const policy = await getProjectIamPolicy(projectId, fetchImpl);
  const bindings = cloneBindings(policy);
  const index = bindings.findIndex((binding) => binding.role === role);
  const binding = index >= 0 ? bindings[index] : { role, members: [] };
  const members = new Set(binding.members);
  const before = members.has(principal);
  if (grant) members.add(principal);
  else members.delete(principal);
  const changed = before !== members.has(principal);
  if (!changed) {
    return { projectId, principal, role, changed: false };
  }
  if (members.size === 0) {
    if (index >= 0) bindings.splice(index, 1);
  } else if (index >= 0) {
    bindings[index] = { ...binding, members: [...members].sort() };
  } else {
    bindings.push({ role, members: [...members].sort() });
  }
  const updated = await setProjectIamPolicy(
    projectId,
    { ...policy, version: 3, bindings },
    fetchImpl,
  );
  return {
    projectId,
    principal,
    role,
    changed: true,
    etag: updated.etag || null,
  };
}

async function updateCloudRunServiceAccount({
  projectId,
  serviceName,
  region,
  serviceAccount,
  fetchImpl,
}) {
  const url = `${CLOUD_RUN_API}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/services/${encodeURIComponent(serviceName)}`;
  await googleJsonRequest(url, { fetchImpl });
  return googleJsonRequest(`${url}?updateMask=spec.template.spec.serviceAccountName`, {
    method: "PATCH",
    body: {
      apiVersion: "serving.knative.dev/v1",
      kind: "Service",
      metadata: { name: serviceName },
      spec: { template: { spec: { serviceAccountName: serviceAccount } } },
    },
    fetchImpl,
  });
}

function triggerBranch(payload) {
  return (
    payload?.github?.push?.branch ||
    payload?.triggerTemplate?.branchName ||
    payload?.repositoryEventConfig?.push?.branch ||
    null
  );
}

async function getCloudBuildTrigger({
  projectId,
  location,
  triggerId,
  triggerName,
  fetchImpl,
}) {
  const expectedResourceName = `projects/${projectId}/locations/${location}/triggers/${triggerId}`;
  const payload = await googleJsonRequest(
    `${CLOUD_BUILD_API}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/triggers/${encodeURIComponent(triggerId)}`,
    { fetchImpl },
  );
  if (payload?.resourceName && payload.resourceName !== expectedResourceName) {
    throw new GoogleCloudActionError(
      "Cloud Build trigger resource-ът не съответства на проверения trigger.",
      409,
      "GOOGLE_CLOUD_TRIGGER_MISMATCH",
    );
  }
  const observedName = payload?.name || payload?.displayName || null;
  if (observedName !== triggerName) {
    throw new GoogleCloudActionError(
      "Cloud Build trigger-ът не съответства на проверения synchron-main-deploy.",
      409,
      "GOOGLE_CLOUD_TRIGGER_MISMATCH",
    );
  }
  if (payload?.disabled === true) {
    throw new GoogleCloudActionError(
      "Cloud Build trigger-ът е изключен.",
      409,
      "GOOGLE_CLOUD_TRIGGER_DISABLED",
    );
  }
  const branch = triggerBranch(payload);
  if (branch && branch !== "^main$" && branch !== "main") {
    throw new GoogleCloudActionError(
      "Cloud Build trigger-ът вече не е ограничен до main.",
      409,
      "GOOGLE_CLOUD_TRIGGER_BRANCH_MISMATCH",
    );
  }
  return payload;
}

async function runCloudBuildTrigger({
  projectId,
  location,
  triggerId,
  commitSha,
  fetchImpl,
}) {
  const payload = await googleJsonRequest(
    `${CLOUD_BUILD_API}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/triggers/${encodeURIComponent(triggerId)}:run`,
    {
      method: "POST",
      body: { commitSha },
      fetchImpl,
    },
  );
  return {
    projectId,
    location,
    triggerId,
    commitSha,
    operationName: typeof payload?.name === "string" ? payload.name : null,
  };
}

export async function confirmGoogleCloudAction(
  { ownerId, sessionId, confirmationId } = {},
  {
    validateConfirmation = validateDurableConfirmation,
    consumeConfirmation = markDurableConfirmationUsed,
    executeWrite = executeAuditedWriteAction,
    adapters = {},
  } = {},
) {
  const confirmation = await validateConfirmation(confirmationId, sessionId);
  if (!Object.values(ACTIONS).includes(confirmation.action)) {
    throw new GoogleCloudActionError(
      "Потвърждението не е за Google Cloud промяна.",
      400,
      "GOOGLE_CLOUD_ACTION_MISMATCH",
    );
  }
  if (confirmation.resource?.ownerFingerprint !== assertOwner(ownerId)) {
    throw new GoogleCloudActionError(
      "Профилът не съответства на потвърдената Google Cloud промяна.",
      403,
      "GOOGLE_CLOUD_OWNER_MISMATCH",
    );
  }

  const resource = confirmation.resource;
  const params = confirmation.params || {};
  const fetchImpl = adapters.fetchImpl || fetch;
  if (confirmation.action === ACTIONS.RUN_CLOUD_BUILD_TRIGGER) {
    await (adapters.getCloudBuildTrigger || getCloudBuildTrigger)({
      ...resource,
      fetchImpl,
    });
  }
  await consumeConfirmation(confirmationId);
  const execute = async () => {
    if (confirmation.action === ACTIONS.GRANT_PROJECT_ROLE) {
      return (adapters.changeProjectRole || changeProjectRole)({
        ...resource,
        grant: true,
        fetchImpl,
      });
    }
    if (confirmation.action === ACTIONS.REVOKE_PROJECT_ROLE) {
      return (adapters.changeProjectRole || changeProjectRole)({
        ...resource,
        grant: false,
        fetchImpl,
      });
    }
    if (confirmation.action === ACTIONS.RUN_CLOUD_BUILD_TRIGGER) {
      return (adapters.runCloudBuildTrigger || runCloudBuildTrigger)({
        ...resource,
        fetchImpl,
      });
    }
    return (adapters.updateCloudRunServiceAccount || updateCloudRunServiceAccount)({
      ...resource,
      serviceAccount: params.serviceAccount,
      fetchImpl,
    });
  };

  return executeWrite({
    action: "infrastructure.write",
    capability: confirmation.action,
    actor: "synchron-x-google-cloud",
    sessionId,
    confirmationId,
    resource: resource.projectId,
    details: confirmation.action,
    execute,
  });
}

export const GOOGLE_CLOUD_CONFIRMED_ACTIONS = ACTIONS;
