import type { Config } from "@react-router/dev/config";

export default {
  prerender: ["/", "/products/abc"],
  future: {
    unstable_subResourceIntegrity: true,
  },
} satisfies Config;
