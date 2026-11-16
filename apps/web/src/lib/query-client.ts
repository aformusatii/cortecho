import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './api-client.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is considered fresh for 10s: navigating back and forth between
      // pages does not refetch every time, but nothing stays stale for long.
      staleTime: 10_000,
      // By default TanStack Query PAUSES requests while offline, which would
      // show a loading skeleton forever. 'always' lets the request fail fast,
      // so the page shows a clear "could not reach the server" message and
      // the offline banner explains why.
      networkMode: 'always',
      // Retrying a 4xx (bad id, validation) cannot succeed, and retrying while
      // the browser knows it is offline only delays the error. Otherwise
      // (network blips, 5xx) retry at most twice.
      retry: (failureCount, error) => {
        if (!navigator.onLine) return false;
        if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      networkMode: 'always',
    },
  },
});
