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

/**
 * An error message fit for `/health`, which anyone who can reach the port can
 * read: every URL cut down to its scheme and host. RPC endpoints carry their
 * key in the path or the query, and RPC errors quote the endpoint.
 */
export function withoutUrlSecrets(message: string): string {
  return message.replace(/(https?|wss?):\/\/(?:[^\s\/@"']*@)?([^\s\/"'?#]+)[^\s"']*/g, "$1://$2/...");
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
