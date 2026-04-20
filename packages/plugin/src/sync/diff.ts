import fastDiff from 'fast-diff';
import type * as Y from 'yjs';

export function applyDiffToYText(
  ytext: Y.Text,
  oldContent: string,
  newContent: string,
  origin: unknown,
): void {
  if (oldContent === newContent) return;

  const ydoc = ytext.doc;
  const apply = () => {
    let offset = 0;
    for (const [op, text] of fastDiff(oldContent, newContent)) {
      if (op === fastDiff.EQUAL) {
        offset += text.length;
      } else if (op === fastDiff.DELETE) {
        ytext.delete(offset, text.length);
      } else if (op === fastDiff.INSERT) {
        ytext.insert(offset, text);
        offset += text.length;
      }
    }
  };

  if (ydoc) {
    ydoc.transact(apply, origin);
  } else {
    apply();
  }
}
