# Dreamweaver Template & Page Syntax

Reference: https://helpx.adobe.com/dreamweaver/using/dreamweaver-templates.html

Dreamweaver uses HTML comment tags to define templates and link pages to those templates. There are two sides to this system: **Templates** (`.dwt` files) and **Pages** (`.html` files that use a template).

---

## Dreamweaver Template (`.dwt`)

Template files live in a `/Templates/` directory and use `TemplateBegin`/`TemplateEnd` comment tags to define editable regions, conditional sections, and template variables.

### Editable Regions

Editable regions mark areas of the template that pages can override. Everything outside editable regions is locked.

```html
<!-- TemplateBeginEditable name="doctitle" -->
<title>Default Title</title>
<!-- TemplateEndEditable -->

<!-- TemplateBeginEditable name="Nav Primary" -->
<nav>...</nav>
<!-- TemplateEndEditable -->
```

### Conditional Regions

Conditional regions show or hide content based on template parameters.

```html
<!-- TemplateBeginIf cond="ID=='newsletter'" -->
<div class="newsletter-banner">...</div>
<!-- TemplateEndIf -->

<!-- TemplateBeginIf cond="_document['Show Full Width Promo']" -->
<section class="promo">...</section>
<!-- TemplateEndIf -->
```

### Template Variable Output

Template variables are output using `@@(...)@@` syntax.

```html
@@(_document['Mainpic Background'])@@
@@(Division)@@
```

---

## Dreamweaver Page (`.html`)

Pages that use a Dreamweaver template contain `InstanceBegin`/`InstanceEnd` comment tags. These reference the template and provide content for its editable regions.

### Template Declaration

Each page declares which template it extends:

```html
<!-- InstanceBegin template="/Templates/Division Page.dwt" codeOutsideHTMLIsLocked="false" -->
...
<!-- InstanceEnd -->
```

### Editable Region Content

Pages fill in the template's editable regions using `InstanceBeginEditable`/`InstanceEndEditable`:

```html
<!-- InstanceBeginEditable name="Header Text" -->
<img src="/assets/img/mp-direct-right.png" class="img-responsive">
<!-- InstanceEndEditable -->
```

### Instance Parameters

Pages set template variable values using `InstanceParam` tags:

```html
<!-- InstanceParam name="Mainpic Background" type="color" value="#187054" -->
<!-- InstanceParam name="ID" type="text" value="newsletter" -->
<!-- InstanceParam name="Show Full Width Promo" type="boolean" value="true" -->
```
