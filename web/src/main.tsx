import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from './lib/auth';
import { ConfirmProvider } from './components/ui';
import { App } from './App';
import { ApiError } from './lib/api';
import { initMonitoring } from './lib/monitoring';
import './index.css';

void initMonitoring();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 20_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ConfirmProvider>
            <App />
            <Toaster position="top-right" richColors closeButton />
          </ConfirmProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
