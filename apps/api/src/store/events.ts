import type { Response } from "express";
import { snapshot } from "./state";

const clients = new Set<Response>();

export function addEventClient(res: Response) {
  clients.add(res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  res.on("close", () => {
    clients.delete(res);
  });
}

export function broadcast(event = "snapshot") {
  const payload = JSON.stringify(snapshot());
  for (const client of clients) {
    client.write(`event: ${event}\ndata: ${payload}\n\n`);
  }
}
