import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { queryClient } from './lib/query-client.ts';
import { routeTree } from './routeTree.gen.ts';
import './index.css';

const router = createRouter({
  routeTree,
  // Vite's `base` ('/' unless DEV_BASE_PATH is set): routes match and links
  // are built below that prefix.
  basepath: import.meta.env.BASE_URL,
  // Move focus/scroll to the top on navigation, like a classic page load.
  scrollRestoration: true,
  defaultPreload: 'intent',
});

// Registers the router type globally so <Link to="..."> and useSearch()
// are type-checked against the real route tree.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
