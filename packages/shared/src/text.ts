/**
 * 文字数をコードポイント数で数える。
 * DB の char_length と同じ数え方にそろえるため(設計書 §1.1)。
 * `string.length`(UTF-16 コード単位)は、絵文字などで DB と食い違う。
 */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) {
    void _;
    count += 1;
  }
  return count;
}
