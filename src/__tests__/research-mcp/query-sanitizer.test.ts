import { expect, test } from "bun:test";

import {
  assertSafeDocumentationUrlShape,
  sanitizeDocumentationQuery,
} from "../../research-mcp/query-sanitizer.js";

test("query sanitizer keeps API symbols and useful behavior terms", () => {
  expect(sanitizeDocumentationQuery("How does NWPathMonitor pathUpdateHandler work? ")).toBe(
    "NWPathMonitor pathUpdateHandler",
  );
  expect(sanitizeDocumentationQuery("CameraView barcodeScannerSettings availability")).toBe(
    "CameraView barcodeScannerSettings availability",
  );
  expect(sanitizeDocumentationQuery("View menuStyle(_:) descendants")).toBe(
    "View menuStyle(_:) descendants",
  );
});

test("query sanitizer removes quoted literals, URLs, paths, and excess prose", () => {
  expect(
    sanitizeDocumentationQuery(
      'Please search "literal value" https://attacker.example /Users/reviewer/private for MainActor isolation',
    ),
  ).toBe("MainActor isolation");
});

test("query sanitizer rejects secret-shaped material and queries without an API anchor", () => {
  expect(() => sanitizeDocumentationQuery("API key: ExampleSecretValue123 MainActor")).toThrow(
    /secret-labeled/,
  );
  expect(sanitizeDocumentationQuery("MainActor Ab3dE5fG7hJ9kLmN2pQrS4tUvW6xY8z")).toBe("MainActor");
  expect(() => sanitizeDocumentationQuery("background behavior availability")).toThrow(
    /API-like symbol/,
  );
});

test("direct URL sanitizer rejects decorations and suspicious outbound path segments", () => {
  expect(
    assertSafeDocumentationUrlShape(
      "https://developer.apple.com/documentation/swiftui/view/menustyle(_:)",
    ).href,
  ).toBe("https://developer.apple.com/documentation/swiftui/view/menustyle(_:)");
  expect(() =>
    assertSafeDocumentationUrlShape(
      "https://developer.apple.com/documentation/swiftui/view?token=secret",
    ),
  ).toThrow(/query string or fragment/);
  expect(() =>
    assertSafeDocumentationUrlShape(
      "https://developer.apple.com/documentation/Ab3dE5fG7hJ9kLmN2pQrS4tUvW6xY8z",
    ),
  ).toThrow(/suspicious path segment/);
});
