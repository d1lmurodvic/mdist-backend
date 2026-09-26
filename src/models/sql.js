/** Small SQL helpers shared by the models. */

/**
 * A LIKE pattern matching `text` literally anywhere: wildcards are escaped,
 * so a search for "50%" means the text "50%". Use with ESCAPE '\'.
 */
export function likePattern(text) {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
