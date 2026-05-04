import http from "node:http";
import { AppConfig } from "../config/types.js";
import { AppDatabase } from "../storage/index.js";
import { LoginManager } from "./login-manager.js";
import { InvalidJsonBodyError, respondJson } from "./response.js";
import { routeHttpRequest } from "./routes.js";

export interface GatewayHttpServerParams {
  config: AppConfig;
  database: AppDatabase;
  loginManager: LoginManager;
  startedAt: string;
}

export function createGatewayHttpServer(
  params: GatewayHttpServerParams,
): http.Server {
  return http.createServer(async (request, response) => {
    try {
      await routeHttpRequest({
        ...params,
        request,
        response,
      });
    } catch (error) {
      if (error instanceof InvalidJsonBodyError) {
        respondJson(response, 400, {
          ok: false,
          error: "invalid_json",
          message: error.message,
        });
        return;
      }

      respondJson(response, 500, {
        ok: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function listenServer(
  server: http.Server,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
