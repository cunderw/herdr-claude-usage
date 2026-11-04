# Reads Claude Code transcript lines (JSONL) and prints one tab-separated record
# per assistant line that carries usage:
#   id  model  timestamp  input  output  cache_read  cache_write_5m  cache_write_1h  speed
# Run with LC_ALL=C so length() counts bytes. `limit` is how many bytes were piped
# in. A last line without its newline is still being written: it is held back,
# and "#used" reports the bytes of whole lines read, so the next read starts there.
# Strings inside JSON escape their quotes, so an unescaped "usage":{ is structure.
# The message's own usage is the last one on the line (it follows the content).
function num(s, key) {
  if (match(s, "\"" key "\":[0-9]+")) return substr(s, RSTART + length(key) + 3, RLENGTH - length(key) - 3) + 0
  return 0
}
function str(s, key) {
  if (match(s, "\"" key "\":\"[^\"]*\"")) return substr(s, RSTART + length(key) + 4, RLENGTH - length(key) - 5)
  return ""
}
function lastidx(s, t,   p, q) {
  p = 0
  while ((q = index(substr(s, p + 1), t)) > 0) p += q
  return p
}
{
  used += length($0) + 1
  if (pending != "") { print pending; pending = "" }
  if (index($0, "\"type\":\"assistant\"") == 0) next
  u = lastidx($0, "\"usage\":{")
  m = index($0, "\"message\":{")
  if (u == 0 || m == 0) next
  head = substr($0, m, 400)
  id = str(head, "id"); model = str(head, "model")
  if (id == "" || model == "" || model == "<synthetic>") next
  us = substr($0, u)
  t = lastidx($0, "\"timestamp\":\"")
  ts = t ? substr($0, t + 13, 24) : ""
  cw = num(us, "cache_creation_input_tokens"); cw1 = num(us, "ephemeral_1h_input_tokens")
  if (cw1 > cw) cw1 = cw
  pending = id "\t" model "\t" ts "\t" num(us, "input_tokens") "\t" num(us, "output_tokens") "\t" num(us, "cache_read_input_tokens") "\t" (cw - cw1) "\t" cw1 "\t" str(us, "speed")
}
END {
  if (used > limit) used -= length($0) + 1; else if (pending != "") print pending
  print "#used\t" used
}
