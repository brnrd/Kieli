import { fileFormats, formatGroups, getFileFormat } from "../formats";

export default function FileFormatSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field-label">
      File format
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {formatGroups.map((group) => (
          <optgroup label={group} key={group}>
            {fileFormats
              .filter((format) => format.group === group)
              .map((format) => (
                <option key={format.id} value={format.id}>
                  {format.label} (.{format.extension})
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <span>{getFileFormat(value).note}</span>
    </label>
  );
}
