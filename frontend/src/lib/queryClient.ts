import { MutationCache, QueryClient } from "@tanstack/react-query";
import { errMsg, toast } from "./toast";

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error) => {
      toast.error(errMsg(error, "Action failed"));
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1 minute
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
