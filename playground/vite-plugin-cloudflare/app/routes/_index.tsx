import type { MetaFunction } from "react-router";
import type { Route } from "./+types/_index";
import { env } from "cloudflare:workers";

export const meta: MetaFunction = () => {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
};

export async function loader({ context }: Route.LoaderArgs) {
  let value = await context.cloudflare.env.KV.get("cache", {
    cacheTtl: 60,
  });

  if (!value) {
    value = new Date().toISOString();
    context.cloudflare.env.KV.put("cache", value);
  }

  return {
    message: env.VALUE_FROM_CLOUDFLARE,
    value,
  };
}

export default function Index({ loaderData }: Route.ComponentProps) {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", lineHeight: "1.8" }}>
      <h1>Welcome to React Router</h1>
      <p>Env: {loaderData.message}</p>
      <p>Cached value from KV: {loaderData.value}</p>
    </div>
  );
}
