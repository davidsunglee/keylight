// Helpers shared by the viewer's tests and checks.

import { createServer } from "node:net";

/** A loopback port the operating system reports free right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("the operating system assigned no port"));
      });
    });
  });
}
