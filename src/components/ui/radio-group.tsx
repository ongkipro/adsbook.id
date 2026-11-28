import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-2", className)}
      {...props}
    />
  )
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-input outline-none group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary",
        className
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="flex size-4 items-center justify-center"
      >
        <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  )
}

export { RadioGroup, RadioGroupItem }

/**
 * Project addition: a radio drawn as a segment of a segmented control or as a
 * selectable card. Radio.Root supplies role="radio", aria-checked, one tab stop
 * for the group and arrow-key selection; the variant supplies the look. Hand-
 * rolled `role="radio"` buttons had none of the keyboard behaviour
 * (admin-controls.test.ts now refuses them).
 */
const radioOptionVariants = cva(
  "outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 data-disabled:pointer-events-none data-disabled:opacity-50",
  {
    variants: {
      variant: {
        // Inside a `bg-muted p-[3px] rounded-lg` track (RADIO_SEGMENT_TRACK).
        segment:
          "flex-1 cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-center text-sm font-medium text-muted-foreground hover:text-foreground data-checked:bg-background data-checked:text-foreground data-checked:shadow-sm",
        // A bordered choice tile; the selected one takes the secondary fill.
        card:
          "flex h-auto cursor-pointer items-start justify-start gap-2 rounded-lg border border-input bg-background p-3 text-left text-sm hover:bg-muted data-checked:border-primary/40 data-checked:bg-secondary",
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
