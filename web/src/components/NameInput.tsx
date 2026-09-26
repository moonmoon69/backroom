/**
 * A field for a name that has no spaces in it (a participant's alias, a preset, a role): spaces typed or pasted are
 * dropped as they arrive, so "  alice " is "alice". The cursor stays where it was rather than jumping to the end.
 */
import { useLayoutEffect, useRef, type InputHTMLAttributes, type RefObject } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onValue: (value: string) => void;
  ref?: RefObject<HTMLInputElement | null> | undefined;
};

export function NameInput({ value, onValue, ref, ...rest }: Props) {
  const own = useRef<HTMLInputElement>(null);
  const input = ref ?? own;
  // Where the cursor belongs after spaces were taken out; set once the new value is in the field.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  return (
    <input
      {...rest}
      ref={input}
      type="text"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      value={value}
      onChange={(event) => {
        const typed = event.target.value;
        const clean = typed.replace(/\s+/g, "");
        if (clean !== typed) {
          const at = event.target.selectionStart ?? typed.length;
          caret.current = typed.slice(0, at).replace(/\s+/g, "").length;
        }
        onValue(clean);
      }}
    />
  );
}
