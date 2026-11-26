import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { PendingRecoveryProvider } from './auth/pending-recovery';

const queryClient = new QueryClient();

const root = document.getElementById('root');
if (!root) throw new Error('#root が見つかりません');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PendingRecoveryProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </PendingRecoveryProvider>
    </QueryClientProvider>
  </StrictMode>,
);
