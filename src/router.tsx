import { QueryClient } from "@tanstack/react-query";
import { createHashHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    // Hash history: the packaged Electron app loads dist/index.html from
    // file://, where pathname-based routing breaks on reload/relaunch.
    history: createHashHistory(),
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
