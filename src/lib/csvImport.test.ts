import { describe, expect, it } from "vitest";
import { importGooglePasswordsCsv } from "./csvImport";

describe("Google Password Manager CSV import", () => {
  it("parses quoted Chrome export rows", () => {
    const imported = importGooglePasswordsCsv(
      'name,url,username,password\n"Example, Inc","https://example.com","alice","s3cret"',
      "folder-1",
    );

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      title: "Example, Inc",
      url: "https://example.com",
      username: "alice",
      password: "s3cret",
      folderId: "folder-1",
    });
  });
});
