import { WORKSPACE_NAME_MAX_LENGTH } from '@raisechat/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { createWorkspace, WORKSPACES_KEY } from '../api/workspaces';
import { setLastWorkspace } from '../auth/last-workspace';

/** ワークスペースの作成(FR-201)。作成者がオーナーになり、作成後は、そのワークスペースを開く */
export function CreateWorkspaceForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
      setLastWorkspace(workspace.id);
      void navigate(`/w/${workspace.id}`);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate(name);
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        ワークスペース名
        <input
          name="workspaceName"
          required
          maxLength={WORKSPACE_NAME_MAX_LENGTH * 2}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <p>{WORKSPACE_NAME_MAX_LENGTH} 文字まで</p>
      {mutation.isError && <p role="alert">{errorMessage(mutation.error)}</p>}
      <button type="submit" disabled={mutation.isPending}>
        作成
      </button>
    </form>
  );
}
