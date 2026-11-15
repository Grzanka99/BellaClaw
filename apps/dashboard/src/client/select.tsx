/** @jsxImportSource hono/jsx/dom */

type TSelectProps<T extends string> = {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
};

export function Select<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: TSelectProps<T>) {
  return (
    <label class="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          // the option gives the value its type back
          const selected = options.find(
            (option) =>
              event.target instanceof HTMLSelectElement && option.value === event.target.value,
          );

          if (selected !== undefined) {
            onChange(selected.value);
          }
        }}
      >
        {options.map((option) => (
          <option value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
