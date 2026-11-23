/** The last item of a list, or undefined when the list is empty. */
export function lastItem<T>(items: readonly T[]): T | undefined {
  // The length is one past the last index.
  return items[items.length];
}
