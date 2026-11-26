import type {
  LoginRequest,
  MeResponse,
  ProfileUpdate,
  RegisterRequest,
  RegisterResponse,
} from '@raisechat/shared';
import { apiFetch } from './client';

export const register = (request: RegisterRequest) =>
  apiFetch<RegisterResponse>('/api/auth/register', { method: 'POST', json: request });

export const login = (request: LoginRequest) =>
  apiFetch<MeResponse>('/api/auth/login', { method: 'POST', json: request });

export const logout = () => apiFetch<void>('/api/auth/logout', { method: 'POST' });

export const updateProfile = (update: ProfileUpdate) =>
  apiFetch<MeResponse>('/api/me', { method: 'PATCH', json: update });

/** アバター画像の差し替え。フィールド名は file(サーバーの仕様) */
export function uploadAvatar(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch<MeResponse>('/api/me/avatar', { method: 'PUT', formData });
}
