import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setBackendForTesting, type Backend } from "@/lib/api";
import { ApiError, normalizeError } from "@/lib/errors";

describe("normalizeError", () => {
  it("keeps a well-formed CommandError", () => {
    const e = normalizeError({ kind: "read_only", message: "Read-only mode is on" });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe("read_only");
    expect(e.message).toBe("Read-only mode is on");
  });

  it("fills a default message when missing", () => {
    expect(normalizeError({ kind: "offline" }).message).toMatch(/not reachable/);
  });

  it("parses a JSON-encoded error string", () => {
    const e = normalizeError('{"kind":"unsupported","message":"No stow on Mini"}');
    expect(e.kind).toBe("unsupported");
    expect(e.message).toBe("No stow on Mini");
  });

  it("wraps a plain string as internal", () => {
    const e = normalizeError("boom");
    expect(e.kind).toBe("internal");
    expect(e.message).toBe("boom");
  });

  it("maps unknown kinds to internal but keeps the text", () => {
    const e = normalizeError({ kind: "quota", message: "Too many" });
    expect(e.kind).toBe("internal");
    expect(e.message).toBe("Too many");
  });

  it("detects timeouts in Error messages", () => {
    expect(normalizeError(new Error("request timed out")).kind).toBe("timeout");
    expect(normalizeError(new Error("nope")).kind).toBe("internal");
  });

  it("handles null / undefined / numbers", () => {
    for (const v of [null, undefined, 42]) {
      const e = normalizeError(v);
      expect(e.kind).toBe("internal");
      expect(e.message).toBeTruthy();
    }
  });

  it("returns the same ApiError instance", () => {
    const e = new ApiError("timeout", "slow");
    expect(normalizeError(e)).toBe(e);
  });
});

describe("api wrappers", () => {
  afterEach(() => setBackendForTesting(null));

  function fakeBackend(impl: Backend["invoke"]): Backend {
    return { invoke: vi.fn(impl), listen: vi.fn(async () => () => undefined) };
  }

  it("passes camelCase args to the command", async () => {
    const b = fakeBackend(async () => []);
    setBackendForTesting(b);
    await api.getHistory(360);
    expect(b.invoke).toHaveBeenCalledWith("get_history", { rangeMinutes: 360 });
  });

  it("rejects with a normalized ApiError", async () => {
    setBackendForTesting(
      fakeBackend(async () => {
        throw { kind: "read_only", message: "Read-only" };
      }),
    );
    await expect(api.rebootDish()).rejects.toMatchObject({ kind: "read_only", message: "Read-only" });
    await expect(api.rebootDish()).rejects.toBeInstanceOf(ApiError);
  });

  it("normalizes string rejections from the transport", async () => {
    setBackendForTesting(
      fakeBackend(async () => {
        throw "dish unreachable";
      }),
    );
    await expect(api.getLiveSnapshot()).rejects.toMatchObject({ kind: "internal", message: "dish unreachable" });
  });
});
