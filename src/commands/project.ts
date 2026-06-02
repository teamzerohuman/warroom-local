import {
  loadRepoManifest,
  resolveProjectConfig,
  updateCampaignProjectInManifest,
} from '../lib/repos.js';
import {
  CAMPAIGN_STATUS_NAMES,
  configureCampaignStatusField,
  createCampaignProject,
  viewCampaignProject,
  type CampaignProject,
  type GhRunner,
  type StatusFieldResult,
} from '../lib/project.js';

export type ProjectSetupResult = {
  mode: 'create' | 'link';
  applied: boolean;
  owner: string;
  title: string | null;
  project: CampaignProject | null;
  statusField: StatusFieldResult | null;
  manifestUpdated: boolean;
  messages: string[];
  error: string | null;
};

export type ProjectCreateOptions = {
  title: string;
  owner?: string;
  confirm?: boolean;
  // Injectable gh runner for tests; production calls use the default real gh.
  runner?: GhRunner;
};

export type ProjectLinkOptions = {
  projectNumber: number;
  owner?: string;
  confirm?: boolean;
  // When true (default), reconcile the existing board's Status field to the six
  // Campaign Map states. Pass false to wire repos.yaml without touching fields.
  ensureStatus?: boolean;
  runner?: GhRunner;
};

// Resolves the Campaign Map owner from an explicit flag, else repos.yaml defaults
// (honouring WARROOM_CAMPAIGN_OWNER), throwing a friendly error when repos.yaml
// is missing so the caller can tell the user to run `warroom setup` first.
function resolveCampaignOwner(workspaceRoot: string, explicit?: string): string {
  if (explicit) return explicit;
  try {
    const manifest = loadRepoManifest(workspaceRoot);
    return resolveProjectConfig(manifest.defaults).campaignOwner;
  } catch {
    throw new Error('Could not resolve a campaign owner — pass --owner or run `warroom setup` to create repos.yaml first.');
  }
}

// Creates a new GitHub Project board, configures its Status field with the six
// Campaign Map states, and points repos.yaml at it. Without `confirm` it returns
// a plan describing those steps without touching GitHub or the manifest.
export function runProjectCreate(workspaceRoot: string, options: ProjectCreateOptions): ProjectSetupResult {
  const result: ProjectSetupResult = {
    mode: 'create',
    applied: false,
    owner: options.owner ?? '',
    title: options.title,
    project: null,
    statusField: null,
    manifestUpdated: false,
    messages: [],
    error: null,
  };

  try {
    const owner = resolveCampaignOwner(workspaceRoot, options.owner);
    result.owner = owner;

    if (!options.confirm) {
      result.messages.push(`Plan: create GitHub Project "${options.title}" under ${owner}.`);
      result.messages.push(`Plan: configure single-select Status field with ${CAMPAIGN_STATUS_NAMES.join(', ')}.`);
      result.messages.push('Plan: set repos.yaml defaults.campaign_owner and defaults.campaign_project_number.');
      result.messages.push('Re-run with --confirm to apply.');
      return result;
    }

    const project = createCampaignProject(owner, options.title, options.runner);
    result.project = project;
    result.messages.push(`Created Project #${project.number} "${project.title}" -> ${project.url}`);

    const statusField = configureCampaignStatusField(owner, project.number, options.runner);
    result.statusField = statusField;
    result.messages.push(
      statusField.created
        ? 'Created Status field with the six Campaign Map states.'
        : statusField.replaced
          ? 'Replaced the default Status field with the six Campaign Map states.'
          : 'Status field already carried the six Campaign Map states.'
    );

    updateCampaignProjectInManifest(workspaceRoot, owner, project.number);
    result.manifestUpdated = true;
    result.messages.push(`Wired repos.yaml -> campaign_owner: ${owner}, campaign_project_number: ${project.number}.`);

    result.applied = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

// Points repos.yaml at an existing GitHub Project board (use-existing path). With
// `confirm` it validates the board exists, reconciles its Status field unless
// disabled, and updates the manifest. Without `confirm` it returns a plan.
export function runProjectLink(workspaceRoot: string, options: ProjectLinkOptions): ProjectSetupResult {
  const ensureStatus = options.ensureStatus ?? true;
  const result: ProjectSetupResult = {
    mode: 'link',
    applied: false,
    owner: options.owner ?? '',
    title: null,
    project: null,
    statusField: null,
    manifestUpdated: false,
    messages: [],
    error: null,
  };

  try {
    if (!Number.isInteger(options.projectNumber) || options.projectNumber < 1) {
      throw new Error(`Project number must be a positive integer (got "${options.projectNumber}").`);
    }
    const owner = resolveCampaignOwner(workspaceRoot, options.owner);
    result.owner = owner;

    if (!options.confirm) {
      result.messages.push(`Plan: link existing Project #${options.projectNumber} under ${owner}.`);
      if (ensureStatus) {
        result.messages.push(`Plan: ensure Status field carries ${CAMPAIGN_STATUS_NAMES.join(', ')}.`);
      }
      result.messages.push('Plan: set repos.yaml defaults.campaign_owner and defaults.campaign_project_number.');
      result.messages.push('Re-run with --confirm to apply.');
      return result;
    }

    const project = viewCampaignProject(owner, options.projectNumber, options.runner);
    if (!project) {
      throw new Error(`Could not find GitHub Project #${options.projectNumber} under ${owner}. Check the owner and project number.`);
    }
    result.project = project;
    result.title = project.title || null;
    result.messages.push(`Found Project #${project.number}${project.title ? ` "${project.title}"` : ''} -> ${project.url}`);

    if (ensureStatus) {
      const statusField = configureCampaignStatusField(owner, project.number, options.runner);
      result.statusField = statusField;
      result.messages.push(
        statusField.created
          ? 'Created Status field with the six Campaign Map states.'
          : statusField.replaced
            ? 'Replaced the existing Status field with the six Campaign Map states.'
            : 'Status field already carried the six Campaign Map states.'
      );
    }

    updateCampaignProjectInManifest(workspaceRoot, owner, project.number);
    result.manifestUpdated = true;
    result.messages.push(`Wired repos.yaml -> campaign_owner: ${owner}, campaign_project_number: ${project.number}.`);

    result.applied = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}
