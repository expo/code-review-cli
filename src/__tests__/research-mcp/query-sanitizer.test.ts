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

test("query sanitizer rejects secret-shaped material and single-word generic queries", () => {
  expect(() => sanitizeDocumentationQuery("API key: ExampleSecretValue123 MainActor")).toThrow(
    /secret-labeled/,
  );
  expect(sanitizeDocumentationQuery("MainActor Ab3dE5fG7hJ9kLmN2pQrS4tUvW6xY8z")).toBe("MainActor");
  expect(() => sanitizeDocumentationQuery("background")).toThrow(/API-like symbol/);
  expect(() => sanitizeDocumentationQuery("how does it work")).toThrow(/API-like symbol/);
});

test("query sanitizer accepts package names and lowercase concept phrases", () => {
  expect(sanitizeDocumentationQuery("expo-camera barcode scanner")).toBe(
    "expo-camera barcode scanner",
  );
  expect(sanitizeDocumentationQuery("gradle configuration cache")).toBe(
    "gradle configuration cache",
  );
  expect(sanitizeDocumentationQuery("coroutine cancellation cooperative")).toBe(
    "coroutine cancellation cooperative",
  );
  expect(sanitizeDocumentationQuery("ios background fetch")).toBe("ios background fetch");
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
