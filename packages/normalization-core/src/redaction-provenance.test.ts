import { describe, expect, it } from "vitest";
import {
  REDACTION_PROVENANCE_END,
  REDACTION_PROVENANCE_START,
  hasRedactionProvenance,
  markRedactionProvenance,
  replaceRedactionProvenance,
} from "./redaction-provenance.js";

const PLACEHOLDER = "[redacted: re-derive this value, do not reuse]";

describe("redaction provenance markers", () => {
  it("marks a produced mask with both boundaries", () => {
    expect(markRedactionProvenance("sk-abc…0xyz")).toBe(
      `${REDACTION_PROVENANCE_START}sk-abc…0xyz${REDACTION_PROVENANCE_END}`,
    );
  });

  it("does not double-wrap an already marked mask", () => {
    const marked = markRedactionProvenance("***");
    expect(markRedactionProvenance(marked)).toBe(marked);
  });

  it("returns the input reference when no marker is present", () => {
    const text = "the file is here…world of pain";
    expect(replaceRedactionProvenance(text, PLACEHOLDER)).toBe(text);
    expect(hasRedactionProvenance(text)).toBe(false);
  });

  it("keeps surrounding text byte-identical around a marked span", () => {
    expect(
      replaceRedactionProvenance(
        `value=${markRedactionProvenance("sk-bug…9f3a")} and trailing`,
        PLACEHOLDER,
      ),
    ).toBe(`value=${PLACEHOLDER} and trailing`);
  });

  it("rewrites several marked spans in one string", () => {
    expect(
      replaceRedactionProvenance(
        `a=${markRedactionProvenance("***")} b=${markRedactionProvenance("nested…t123")}`,
        PLACEHOLDER,
      ),
    ).toBe(`a=${PLACEHOLDER} b=${PLACEHOLDER}`);
  });

  it("leaves an unterminated opener verbatim", () => {
    const text = `keep ${REDACTION_PROVENANCE_START}sk-abc no closing marker`;
    expect(replaceRedactionProvenance(text, PLACEHOLDER)).toBe(text);
  });

  it("leaves literal markdown and ellipsis text untouched", () => {
    const text = "***\nfix ***bold italic*** now\nthe file is here…world of pain";
    expect(replaceRedactionProvenance(text, PLACEHOLDER)).toBe(text);
  });
});
