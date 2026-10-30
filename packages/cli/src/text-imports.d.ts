// Files embedded in the CLI as text.
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*.md" {
  const text: string;
  export default text;
}
