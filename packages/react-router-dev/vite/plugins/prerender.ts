import type * as Vite from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PrerenderFile {
  /**
   * The filename relative to the build output directory
   * e.g., "about.html", "api/data.json", "about/index.html"
   *
   * Leading slash will be removed if present ("/about.html" -> "about.html")
   */
  path: string;
  /**
   * The file contents to write
   */
  contents: string | Uint8Array<ArrayBuffer>;
}

export type PrerenderHandler = (
  path: string | URL,
  init?: RequestInit,
) => Promise<PrerenderFile[]>;

export type WriteFileHandler = (
  file: PrerenderFile,
  outDir?: string,
) => Promise<string>;
export interface PrerenderContext {
  /**
   * Array of paths to prerender
   */
  paths: string[];

  /**
   * Vite resolved configuration
   */
  viteConfig: Vite.ResolvedConfig;

  /**
   * Current vite environment
   */
  environment: Vite.Environment;

  /**
   * Prerender a single path
   *
   * @param request - The prerender request
   * @returns Array of files to write
   */
  prerender: PrerenderHandler;

  /**
   * Write a file to the build directory
   *
   * @param file - File to write
   * @returns Absolute path to the written file
   */
  writeFile: WriteFileHandler;
}

export interface PrerenderPluginConfig {
  /**
   * Paths to prerender - can be an array or a function that returns an array
   * e.g., ["/", "/about", "/blog/post-1"]
   * or () => ["/", "/about"]
   *
   * If there are no paths returned, prerendering will be skipped.
   */
  paths: string[] | (() => string[] | Promise<string[]>);

  /**
   * Whether prerendering is enabled
   */
  isEnabled?: boolean | (() => boolean);

  /**
   * Post-process server responses to generate output files
   *
   * Receives redirect responses when max redirects exceeded. External redirects
   * are skipped and will not reach this function.
   *
   * @param prerenderPath - The path that was prerendered (e.g., "/about")
   * @param response - Response object or Error after all retries
   * @returns Array of files to write
   */
  postProcess?: (
    request: Request,
    response: Response | Error,
  ) => PrerenderFile[] | Promise<PrerenderFile[]>;

  /**
   * Number of times to retry failed requests
   *
   * Retries 5xx errors and timeout errors. Does not retry 4xx client errors.
   *
   * @default 0
   */
  retryCount?: number;

  /**
   * Delay in milliseconds between retry attempts
   *
   * @default 500
   */
  retryDelay?: number;

  /**
   * Maximum number of redirects to follow
   *
   * @default 0
   */
  maxRedirects?: number;

  /**
   * Request timeout in milliseconds
   *
   * @default 10000
   */
  timeout?: number;

  /**
   * Custom handler for full control over orchestration
   *
   * @param context - Prerender context with paths and utilities
   */
  handler?: (context: PrerenderContext) => Promise<void>;
}

/**
 * Vite plugin for prerendering using the preview server
 *
 * @example
 * ```ts
 * export default {
 *   plugins: [
 *     prerender({
 *       paths: async () => {
 *         const posts = await fetchPosts();
 *         return ["/", "/about", ...posts.map(p => `/blog/${p.slug}`)];
 *       },
 *       postProcess: async (request, response) => {
 *         const prerenderPath = new URL(request.url).pathname;
 *
 *         if (response instanceof Error || !response.ok) {
 *           throw new Error(`Prerender failed for ${prerenderPath}`, {
 *             cause: response,
 *           });
 *         }
 *
 *         return [{
 *           path: path.join(prerenderPath, "index.html"),
 *           contents: await response.text(),
 *         }];
 *       },
 *       handler: async ({ paths, prerender, writeFile, viteConfig }) => {
 *         viteConfig.logger.info(`Starting prerendering for ${paths.length} path(s)...`);
 *
 *         for (const prerenderPath of paths) {
 *           const files = await prerender(prerenderPath);
 *           for (const file of files) {
 *             const filePath = await writeFile(file);
 *             viteConfig.logger.info(`Prerender: ${prerenderPath} -> ${filePath}`);
 *           }
 *         }
 *         viteConfig.logger.info(`✓ Prerendered ${paths.length} path(s)`);
 *     }),
 *   ],
 * };
 * ```
 */
export function prerender(config: PrerenderPluginConfig): Vite.Plugin {
  const {
    paths,
    isEnabled,
    postProcess = defaultPostProcess,
    handler = defaultHandler,
    maxRedirects = 0,
    retryCount = 0,
    retryDelay = 500,
    timeout = 10000,
  } = config;

  let viteConfig: Vite.ResolvedConfig;

  return {
    name: "prerender",
    configResolved(resolvedConfig) {
      viteConfig = resolvedConfig;
    },
    writeBundle: {
      async handler() {
        if (this.environment.name === "client") {
          return;
        }

        const enabled =
          typeof isEnabled === "function" ? isEnabled() : isEnabled;

        // Skip prerendering if explicitly disabled
        if (enabled === false) {
          return;
        }

        const prerenderPaths =
          typeof paths === "function" ? await paths() : paths;

        // Skip if not explicitly enabled and there is no path to prerender
        if (enabled === undefined && prerenderPaths.length === 0) {
          return;
        }

        const previewServer = await startPreviewServer(viteConfig);

        try {
          const baseUrl = getBaseUrl(previewServer);

          await handler({
            paths: prerenderPaths,
            viteConfig,
            environment: this.environment,
            prerender: async (prerenderPath, init) => {
              let attemptCount = 0;
              let redirectCount = 0;

              const prerenderUrl = new URL(prerenderPath, baseUrl.toString());

              if (prerenderUrl.origin !== baseUrl.origin) {
                prerenderUrl.hostname = baseUrl.hostname;
                prerenderUrl.protocol = baseUrl.protocol;
                prerenderUrl.port = baseUrl.port;
              }

              const request = new Request(prerenderUrl, init);

              async function handle(url: URL): Promise<PrerenderFile[]> {
                const signal = AbortSignal.timeout(timeout);

                try {
                  const response = await fetch(url, {
                    ...init,
                    redirect: "manual", // Disable automatic redirect following
                    signal,
                  });

                  if (
                    response.status >= 300 &&
                    response.status < 400 &&
                    response.headers.has("location") &&
                    ++redirectCount <= maxRedirects
                  ) {
                    const location = response.headers.get("location")!;

                    const responseURL = new URL(response.url);
                    const locationUrl = new URL(location, response.url);

                    // External redirect: skip
                    if (responseURL.origin !== locationUrl.origin) {
                      return [];
                    }

                    // Internal redirect within limit: follow it
                    const redirectUrl = new URL(location, url);
                    return await handle(redirectUrl);
                  }

                  if (response.status >= 500 && ++attemptCount <= retryCount) {
                    await new Promise((resolve) =>
                      setTimeout(resolve, retryDelay),
                    );

                    return await handle(url);
                  }

                  return postProcess(request, response);
                } catch (error) {
                  if (++attemptCount <= retryCount) {
                    await new Promise((resolve) =>
                      setTimeout(resolve, retryDelay),
                    );
                    return await handle(url);
                  }

                  return postProcess(
                    request,
                    new Error(`Fetch failed for ${prerenderPath}`, {
                      cause: error,
                    }),
                  );
                }
              }

              return await handle(prerenderUrl);
            },
            writeFile: async (file, outDir) => {
              // Removes leading slash if present (e.g. pathname "/about" -> "about")
              const normalizedPath = file.path.startsWith("/")
                ? file.path.slice(1)
                : file.path;
              const outputPath = path.join(
                outDir ?? viteConfig.environments.client.build.outDir,
                ...normalizedPath.split("/"),
              );

              await mkdir(path.dirname(outputPath), { recursive: true });
              await writeFile(outputPath, file.contents);
              return path.relative(viteConfig.root, outputPath);
            },
          });
        } finally {
          await new Promise<void>((resolve, reject) => {
            previewServer.httpServer.close((err) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          });
        }
      },
    },
  };
}

/**
 * Default postProcess implementation
 *
 * Generates HTML files: "/" → "index.html", "/about" → "about/index.html"
 * Throws on errors, and non-OK responses.
 */
async function defaultPostProcess(
  request: Request,
  response: Response | Error,
): Promise<PrerenderFile[]> {
  const prerenderPath = new URL(request.url).pathname;

  if (response instanceof Error || !response.ok) {
    throw new Error(`Prerender failed for ${prerenderPath}`, {
      cause: response,
    });
  }

  return [
    {
      path: path.join(prerenderPath, "index.html"),
      contents: await response.text(),
    },
  ];
}

/**
 * Default handler implementation - processes paths sequentially and logs progress
 */
async function defaultHandler({
  paths,
  prerender,
  writeFile,
  viteConfig,
}: PrerenderContext) {
  viteConfig.logger.info(
    `Starting prerendering for ${paths.length} path(s)...`,
  );

  // Process paths sequentially
  for (const prerenderPath of paths) {
    const files = await prerender(prerenderPath);

    // Write each file and log
    for (const file of files) {
      const filePath = await writeFile(file);
      viteConfig.logger.info(`Prerender: ${prerenderPath} -> ${filePath}`);
    }
  }

  viteConfig.logger.info(`✓ Prerendered ${paths.length} path(s)`);
}

/**
 * Starts Vite preview server for prerendering
 */
async function startPreviewServer(
  viteConfig: Vite.ResolvedConfig,
): Promise<Vite.PreviewServer> {
  const vite = await import("vite");

  try {
    return await vite.preview({
      configFile: viteConfig.configFile,
      logLevel: "info",
      preview: {
        port: 0,
        open: false,
      },
    });
  } catch (error) {
    throw new Error("Failed to start Vite preview server for prerendering", {
      cause: error,
    });
  }
}

/**
 * Gets base URL from preview server
 */
function getBaseUrl(previewServer: Vite.PreviewServer): URL {
  const baseUrl = previewServer.resolvedUrls?.local?.[0];

  if (!baseUrl) {
    throw new Error("Failed to start preview server");
  }

  return new URL(baseUrl);
}
