import '@fontsource-variable/manrope';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRussianErrors } from '@zapas/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ApiError } from './api/client';
import { App } from './app/App';
import { AuthProvider } from './auth/AuthProvider';
import { ScopeProvider } from './auth/ScopeProvider';
import { ThemeProvider } from './lib/theme';
import { UiModeProvider } from './lib/uiMode';
import { ConfirmProvider } from './components/Toast/Confirm';
import { ToastProvider } from './components/Toast/Toast';
import './styles/global.scss';

useRussianErrors();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <UiModeProvider>
          <BrowserRouter>
            <ToastProvider>
              <ConfirmProvider>
                <AuthProvider>
                  <ScopeProvider>
                    <App />
                  </ScopeProvider>
                </AuthProvider>
              </ConfirmProvider>
            </ToastProvider>
          </BrowserRouter>
        </UiModeProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Приложение открывается без связи: сохраняем оболочку. В разработке service worker только мешал бы обновлению кода.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
