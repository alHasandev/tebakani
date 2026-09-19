export class DomainError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "DomainError";
  }
}
