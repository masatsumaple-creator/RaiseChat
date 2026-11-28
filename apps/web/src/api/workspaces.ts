import type {
  CreateInvitationRequest,
  InvitationAcceptResponse,
  InvitationCreatedResponse,
  InvitationPreviewResponse,
  InvitationResponse,
  MemberResponse,
  WorkspaceResponse,
} from '@raisechat/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

export const WORKSPACES_KEY = ['workspaces'] as const;
export const workspaceKey = (id: string) => ['workspaces', id] as const;
export const membersKey = (id: string) => ['workspaces', id, 'members'] as const;
export const invitationsKey = (id: string) => ['workspaces', id, 'invitations'] as const;

export const listWorkspaces = (signal?: AbortSignal) =>
  apiFetch<WorkspaceResponse[]>('/api/workspaces', { signal });

export const createWorkspace = (name: string) =>
  apiFetch<WorkspaceResponse>('/api/workspaces', { method: 'POST', json: { name } });

export const getWorkspace = (id: string, signal?: AbortSignal) =>
  apiFetch<WorkspaceResponse>(`/api/workspaces/${id}`, { signal });

export const listMembers = (id: string, signal?: AbortSignal) =>
  apiFetch<MemberResponse[]>(`/api/workspaces/${id}/members`, { signal });

export const listInvitations = (id: string, signal?: AbortSignal) =>
  apiFetch<InvitationResponse[]>(`/api/workspaces/${id}/invitations`, { signal });

export const createInvitation = (id: string, request: CreateInvitationRequest) =>
  apiFetch<InvitationCreatedResponse>(`/api/workspaces/${id}/invitations`, {
    method: 'POST',
    json: request,
  });

export const revokeInvitation = (workspaceId: string, invitationId: string) =>
  apiFetch<void>(`/api/workspaces/${workspaceId}/invitations/${invitationId}`, {
    method: 'DELETE',
  });

export const previewInvitation = (token: string, signal?: AbortSignal) =>
  apiFetch<InvitationPreviewResponse>(`/api/invitations/${encodeURIComponent(token)}`, { signal });

export const acceptInvitation = (token: string) =>
  apiFetch<InvitationAcceptResponse>(`/api/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
  });

/** 自分が所属するワークスペースの一覧 */
export function useWorkspaces() {
  return useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: ({ signal }) => listWorkspaces(signal),
    retry: false,
  });
}
