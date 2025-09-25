import type { Config } from "@react-router/dev/config";

export default {
  prerender: true,
  future: {
    unstable_viteEnvironmentApi: true,
  },
} satisfies Config;
