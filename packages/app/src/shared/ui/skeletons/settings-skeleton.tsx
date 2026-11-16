import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import * as Skeleton from '@oxy.so/bloom/skeleton';

/** What sits at the end of a settings row once its data is here. */
export type SettingsControlShape = 'value' | 'switch' | 'none';

const LABEL_WIDTHS = [128, 160, 108, 144] as const;

function ControlShape({ shape }: { shape: SettingsControlShape }) {
  if (shape === 'none') return null;
  // The value field is 202 x 32 and the switch 52 x 28: Bloom's own measures.
  return shape === 'switch' ? (
    <Skeleton.Box width={52} height={28} borderRadius={14} />
  ) : (
    <Skeleton.Box width={202} height={32} borderRadius={10} />
  );
}

/** Settings placeholders use the same row geometry as their loaded controls. */
export function SettingsSkeletonRows({
  rows = 1,
  control = 'value',
}: {
  rows?: number;
  control?: SettingsControlShape;
}) {
  return (
    <Skeleton.Region>
      {Array.from({ length: rows }, (_, index) => (
        <GroupedSectionItem
          key={index}
          title=""
          content={<Skeleton.Box width={LABEL_WIDTHS[index % LABEL_WIDTHS.length]} height={14} />}
          rightElement={<ControlShape shape={control} />}
        />
      ))}
    </Skeleton.Region>
  );
}

/** A whole settings card of {@link SettingsSkeletonRows}. */
export function SettingsRowsSkeleton(props: { rows?: number; control?: SettingsControlShape }) {
  return (
    <GroupedSection>
      <SettingsSkeletonRows {...props} />
    </GroupedSection>
  );
}
