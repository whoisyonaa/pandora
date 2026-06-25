import type { VaultEntry } from "../types/vault";

function parseLine(line: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

export function importGooglePasswordsCsv(csv: string, folderId: string): VaultEntry[] {
  const [headerLine, ...rows] = csv.trim().split(/\r?\n/);
  if (!headerLine) return [];
  const headers = parseLine(headerLine).map((header) => header.toLowerCase());
  const get = (cells: string[], key: string) => cells[headers.indexOf(key)] || "";
  const timestamp = new Date().toISOString();

  return rows
    .filter((row) => row.trim())
    .map((row) => {
      const cells = parseLine(row);
      return {
        id: crypto.randomUUID(),
        title: get(cells, "name") || get(cells, "url") || "Imported entry",
        url: get(cells, "url"),
        username: get(cells, "username"),
        password: get(cells, "password"),
        icon: (get(cells, "name") || "IM").slice(0, 2).toUpperCase(),
        folderId,
        tags: ["imported"],
        notes: "Imported from Google Password Manager CSV.",
        createdAt: timestamp,
        updatedAt: timestamp,
        usedCount: 0,
      };
    });
}
