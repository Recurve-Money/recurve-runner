import {createServer, type Server} from "node:http";

/**
 * What an operator (or Railway's healthcheck) can ask the runner. One JSON
 * document, updated after every round: alive is not the same as working, and
 * this says which.
 */
export interface Status {
  ok: boolean;
  chainId: number;
  account: string;
  vault: string;
  dryRun: boolean;
  paused: boolean;
  startedAt: string;
  rounds: number;
  lastRoundAt: string | null;
  lastAction: string | null;
  lastError: string | null;
  /** Consecutive failed rounds. Resets on the first good one. */
  failing: number;
}

export function serveStatus(port: number, status: () => Status): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/health") {
      res.writeHead(404, {"content-type": "application/json"});
      res.end(JSON.stringify({error: "not found"}));
      return;
    }
    const s = status();
    res.writeHead(s.ok ? 200 : 503, {"content-type": "application/json"});
    res.end(JSON.stringify(s, null, 2));
  });
  server.listen(port);
  return server;
}
