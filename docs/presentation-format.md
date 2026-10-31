# Markdown presentation format

This document defines the version 1 presentation format.

## Failure risks

The implementation must control these failures before it reads or writes a presentation:

- A slide separator inside a fenced code block can split code and lose content.
- A metadata marker inside a fenced code block can activate presentation mode by mistake.
- Consecutive separators can remove intentional blank slides.
- A front matter parser can change unknown keys, comments, spacing, or scalar syntax.
- Invalid JSON can cause an editor to replace the document with an empty deck.
- A future metadata version can contain fields that version 1 cannot interpret safely.
- Duplicate slide or element identifiers can make selection and connectors ambiguous.
- Invalid coordinates can move an element outside the slide or cause invalid CSS.
- Excessive numeric values can slow rendering or create an unusable export.
- A connector can refer to a missing element or an element on another slide.
- A serializer can place the metadata block inside an open code fence.
- A serializer can omit Markdown text when it writes visual layout metadata.
- A stale metadata copy can hide a source edit to text or an image.
- A source marker can refer to a missing or incompatible element.
- Source text can contain a line that matches a framing marker.
- A horizontal rule inside an element can become a slide separator.
- An unclosed code fence can hide the next structural marker.
- An image data URL can be truncated during a parse and serialize cycle.
- Platform newline conversion can change a document that the user did not edit.

The parser throws `PresentationFormatError` for invalid or unsupported presentation metadata.
It does not replace invalid metadata with default values.

## File layout

A presentation remains one Markdown file. It has three ordered sections:

1. Optional YAML front matter.
2. Standard Markdown slide content.
3. One terminal presentation metadata block.

The parser preserves the complete front matter block. This includes its delimiters and final newline.
The serializer writes that block without parsing or normalizing YAML.

An isolated horizontal rule separates slides:

```markdown
# First slide

---

# Second slide
```

A separator inside a backtick or tilde code fence stays in the slide content.
Consecutive separators represent blank slides.

## Metadata block

The metadata block starts and ends on isolated lines:

```markdown
<!-- mdsh-presentation
{"version":1,"width":1280,"height":720,"theme":"light","slides":[{"id":"slide-1","background":"#ffffff","notes":"","elements":[]}]}
-->
```

The block must be the last non-whitespace content in the file.
The parser only recognizes a block outside fenced code.
The parser accepts the HTML comment terminators `-->` and `--!>`.
The serializer always writes the canonical `-->` terminator.
The serializer uses JSON Unicode escapes for angle brackets inside metadata.
This rule prevents metadata values from closing the Markdown comment.
The JSON object stores the visual layout.
The Markdown body controls slide order and source-backed content.

Version 1 uses slide coordinates in CSS pixels. The default slide size is 1280 by 720.
A 4:3 deck can use 960 by 720. Custom sizes are valid within the documented limits.

The order of the `slides` array is the slide order.
The order of each `elements` array is its stacking order.
The last element renders above earlier elements.

## Markdown content

The standard Markdown section remains useful without mdsh.
Each imported Markdown slide becomes one editable text element.
The element keeps the slide Markdown in its `content` field.

The serializer frames each source-backed element with isolated start and end markers:

```markdown
<!-- mdsh-slide:slide-1 -->

<!-- mdsh-element:title-1 -->
# First slide
<!-- mdsh-end-element:title-1 gap=1 -->

---

<!-- mdsh-slide:slide-2 -->

<!-- mdsh-element:image-1 -->
![Image](data:image/png;base64,AAAA)
<!-- mdsh-end-element:image-1 gap=1 -->
```

The parser recognizes identity markers only outside closed code fences.
Slide markers connect body sections to slide metadata.
Element markers connect Markdown blocks to text or image metadata.
Element identifiers are unique across the complete deck.
The end marker keeps exact trailing line breaks.
Its `gap` value identifies one framing line break that is not element content.

The serializer prefixes a conflicting literal line with this invisible comment:

```markdown
<!-- mdsh-literal -->
<!-- mdsh-element:user-example -->
```

The prefix escapes one following line.
The parser removes the prefix and keeps the following line unchanged.
The serializer also escapes a literal `<!-- mdsh-literal -->` line.
This recursive rule keeps the transformation reversible.

The serializer escapes framing markers and horizontal rules outside closed code fences.
Markers inside a closed backtick or tilde fence remain literal source text.
An unclosed fence receives a synthetic closing line before its element end marker.
The end marker records that closer with `fence=b3` or `fence=t3`.
The letter selects backticks or tildes. The number gives the fence length.
The parser removes the synthetic closer and restores the original unclosed fence.

These rules keep the Markdown body readable in another editor.
They also prevent element content from changing slide boundaries or presentation metadata.

The body controls slide order and text or image content.
The metadata controls geometry, styles, shapes, notes, and connector attachments.
Source edits therefore update existing elements instead of using stale metadata content.
Serialized text and image elements use an empty metadata `content` value.
This rule prevents duplicate text and large duplicate data images.

Unmarked nonempty Markdown becomes one text element on its slide.
An imported blank document creates one blank slide without elements.
Parsing an ordinary document does not change its source string.
Serializing an unedited ordinary document returns its original bytes.
The editor writes presentation metadata only after the first layout change.

The serializer writes text and image content into the standard Markdown section.
Shapes and connectors remain in the metadata because standard Markdown cannot describe them.
Speaker notes remain in the metadata.

## Validation

The parser accepts metadata version 1 only. It rejects other versions.
The editor shows the parse error and keeps the source unchanged.
It validates every required scalar, identifier, enum, array, and object.
It rejects unknown element types and unsafe numeric values.
It rejects duplicate identifiers and invalid connector references.

The serializer applies the same validation before it writes data.
Creation helpers provide safe defaults for new decks, slides, and elements.
Geometry helpers keep edited rectangles inside the slide bounds.

## Compatibility

`isPresentation()` checks for the terminal metadata block.
It returns true for malformed presentation metadata so callers can show the parse error.
It returns false when the only marker is inside a fenced code block.
It also ignores a marker inside YAML front matter or framed element content.

The existing presentation reader can continue to split ordinary Markdown on horizontal rules.
The visual editor uses this format only when the metadata block is present.
