import {
  applyCampaignLabels,
  checkCampaignLabels,
  checkCampaignStatusOptions,
  setCampaignStatus,
  type CampaignStatusName,
} from '../lib/campaign.js';
import { loadRepoManifest } from '../lib/repos.js';

export type CampaignLabelsOptions = {
  apply?: boolean;
  confirm?: boolean;
};

export type CampaignStatusOptions = {
  issue: string;
  status: CampaignStatusName;
  confirm?: boolean;
  reason?: string;
};

export function runCampaignLabels(workspaceRoot: string, options: CampaignLabelsOptions = {}) {
  const manifest = loadRepoManifest(workspaceRoot);
  if (options.apply) return applyCampaignLabels(manifest, options.confirm ?? false);
  return checkCampaignLabels(manifest);
}

export function runCampaignStatusCheck() {
  return checkCampaignStatusOptions();
}

export function runCampaignStatus(options: CampaignStatusOptions) {
  return setCampaignStatus(options.issue, options.status, {
    confirm: options.confirm,
    reason: options.reason,
  });
}
