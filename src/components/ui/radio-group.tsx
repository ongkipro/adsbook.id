import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full grid-cols-1 gap-2", className)}
      {...props}
    />
  )
}

export { RadioGroup }

/**
 * Project addition: a radio drawn as a segment of a segmented control or as a
 * selectable card. Radio.Root supplies role="radio", aria-checked, one tab stop
 * for the group and arrow-key selection; the variant supplies the look. Hand-
 * rolled `role="radio"` buttons had none of the keyboard behaviour
 * (admin-controls.test.ts now refuses them).
 */
const radioOptionVariants = cva(
  // The focus ring is declared for the checked state too: a checked option is the
  // group's tab stop, and a call site's `data-checked:ring-*` would otherwise win.
  "outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 data-checked:focus-visible:ring-2 data-checked:focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-50",
  {
    variants: {
      variant: {
        // Inside a `bg-muted p-[3px] rounded-lg` track (RADIO_SEGMENT_TRACK).
        segment:
          "inline-flex flex-1 cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-center text-sm font-medium text-muted-foreground hover:text-foreground data-checked:bg-background data-checked:text-foreground data-checked:shadow-sm",
        // A bordered choice tile; the selected one takes the secondary fill.
        card:
          "flex h-auto cursor-pointer items-start justify-start gap-2 rounded-lg border border-input bg-background p-3 text-left text-sm hover:bg-muted data-checked:border-primary data-checked:bg-primary/10 data-checked:hover:bg-primary/10",
        // The call site draws everything (a colour swatch).
        bare: "cursor-pointer",
      },
    },
    defaultVariants: { variant: "card" },
  }
)

/** The track a group of `segment` options sits in. */
const RADIO_SEGMENT_TRACK = "inline-flex w-full gap-0 rounded-lg bg-muted p-[3px]"

function RadioGroupOption({
  className,
  variant,
  ...props
}: RadioPrimitive.Root.Props & VariantProps<typeof radioOptionVariants>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-option"
      className={cn(radioOptionVariants({ variant }), className)}
      {...props}
    />
  )
}

export { RadioGroupOption, RADIO_SEGMENT_TRACK }
