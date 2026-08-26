import { z } from "zod";

// Remove each default wrapper from one field. The wrapper can sit at the
// top, or under an optional or nullable wrapper, so this walks the chain and
// keeps those wrappers. The field then has no default at any level of the
// outer chain.
function fieldWithoutDefault(field: z.ZodTypeAny): z.ZodTypeAny {
  if (field instanceof z.ZodDefault) {
    const wrapper = field as z.ZodTypeAny & {
      unwrap?: () => z.ZodTypeAny;
      removeDefault?: () => z.ZodTypeAny;
      _def: { innerType?: z.ZodTypeAny };
    };
    const inner = typeof wrapper.unwrap === "function"
      ? wrapper.unwrap()
      : typeof wrapper.removeDefault === "function"
        ? wrapper.removeDefault()
        : wrapper._def.innerType;
    if (!inner) throw new Error("Zod default wrapper has no inner type");
    return fieldWithoutDefault(inner);
  }
  if (field instanceof z.ZodOptional) {
    return z.optional(field.unwrap() as z.ZodTypeAny);
  }
  if (field instanceof z.ZodNullable) {
    return z.nullable(field.unwrap() as z.ZodTypeAny);
  }
  return field;
}

// Zod keeps a field default active after partial. A patch parse then fills the
// default for an absent key. The merge then overwrites a stored value that the
// caller did not send. A patch schema must keep only the keys the caller sends.
// This helper removes each top-level field default from an object shape.
// partial then leaves an absent key absent.
export function shapeWithoutDefaults(shape: z.ZodRawShape): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      fieldWithoutDefault(field as z.ZodTypeAny),
    ]),
  );
}

// Build a patch object schema from a base object schema. The result drops each
// top-level default, so a partial parse keeps only the keys the caller sends.
// Chain partial and any extend or refine on the result.
export function objectWithoutDefaults<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): z.ZodObject<T> {
  return z.object(shapeWithoutDefaults(schema.shape)) as unknown as z.ZodObject<T>;
}
