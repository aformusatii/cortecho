import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell.tsx';
import { PwaUpdateToast } from '@/components/PwaUpdateToast.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Toaster } from '@/components/ui/sonner.tsx';

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    <AppShell>
      <Outlet />
      <Toaster
        position="bottom-right"
        richColors
        closeButton
        offset={{ bottom: 88, right: 16 }}
        mobileOffset={{ bottom: 88, right: 16 }}
      />
      <PwaUpdateToast />
    </AppShell>
  );
}

function NotFound() {
  return (
    <div className="space-y-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">The page you are looking for does not exist.</p>
      <Button asChild variant="outline">
        <Link to="/">Go to the status page</Link>
      </Button>
    </div>
  );
}
