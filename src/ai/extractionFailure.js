/** A failure the document records; `code` is the documents.failure_code value. */
export class ExtractionFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
