// The MCP SDK Client compiles every tool's outputSchema with Ajv inside
// listTools(), synchronously: a server listing ~180 tools held the daemon's
// event loop for 1-2 s on every connect. This validator compiles each schema
// on the tool's first structured result instead, and creates the SDK's Ajv
// validator (same options and error text) on first use too.
// A schema declaring an `$id` anywhere registers it in the client's Ajv, and a
// schema referencing anything outside itself resolves against what is
// registered by then (failing the listing when it is not); both still compile
// when listed, in listing order, exactly as the SDK does.
const LISTING_ORDER_SCHEMA = /"\$id"|"\$ref":"(?!#)/;

export function createLazyOutputValidator(AjvJsonSchemaValidator) {
  let provider = null;
  const shared = () => (provider ??= new AjvJsonSchemaValidator());
  return {
    getValidator(schema) {
      if (LISTING_ORDER_SCHEMA.test(JSON.stringify(schema))) return shared().getValidator(schema);
      let validate = null;
      return (input) => {
        validate ??= shared().getValidator(schema);
        return validate(input);
      };
    },
  };
}
