# keylight writer for the Theme utility (~/.config/theme).
#
# Links every slug's Ghostty theme file into keylight's config directory and
# records which pair keylight follows when no theme is picked in the viewer.
# keylight derives all of its colors from those files, so no per-theme map is
# needed here.
#
# Install: add this function to ~/.config/theme/apply.zsh, and call
# `_theme_write_keylight` from the writer list in _theme_propagate.

_theme_write_keylight() {
  local dir="${KEYLIGHT_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/keylight}"
  local slug file
  mkdir -p "$dir/themes" || return 1
  for slug in $THEME_SLUGS; do
    file="$(_theme_ghostty_file "${THEME_GHOSTTY[$slug]}")" || continue
    [[ "$dir/themes/$slug" -ef "$file" ]] || ln -sfn "$file" "$dir/themes/$slug"
  done

  # A pin applies to both appearances, as it does for the other tools.
  local pin; pin="$(_theme_get pin)"
  local conf="light = ${pin:-$(_theme_get light)}"$'\n'"dark = ${pin:-$(_theme_get dark)}"
  [[ -r "$dir/theme.conf" && "$(<"$dir/theme.conf")" == "$conf" ]] && return 0
  print -r -- "$conf" > "$dir/theme.conf.tmp" && mv -f "$dir/theme.conf.tmp" "$dir/theme.conf"
}
