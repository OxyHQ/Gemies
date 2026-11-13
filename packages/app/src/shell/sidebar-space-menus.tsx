import { SPACE_MAX_AGENTS, type Space } from '@/shared/contracts/spaces';
import { useTranslation } from '@/shared/i18n/use-translation';
import { MoreTrigger } from '@/shell/sidebar-menus';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@oxy.so/bloom/dropdown-menu';
import React from 'react';

/** A space folder's menu: rename, edit the brief, add an agent, delete. */
export const SpaceActions = React.memo(function SpaceActions({
  space,
  onRename,
  onEditBrief,
  onAddAgent,
  onDelete,
}: {
  space: Space;
  onRename: (space: Space) => void;
  onEditBrief: (space: Space) => void;
  onAddAgent: (space: Space) => void;
  onDelete: (space: Space) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <MoreTrigger label={t('spaces.options', { name: space.name })} />
      <DropdownMenuContent minWidth={190}>
        <DropdownMenuItem onPress={() => onRename(space)}>{t('spaces.rename')}</DropdownMenuItem>
        <DropdownMenuItem onPress={() => onEditBrief(space)}>
          {t('spaces.editBrief')}
        </DropdownMenuItem>
        {space.memberAgentIds.length < SPACE_MAX_AGENTS ? (
          <DropdownMenuItem onPress={() => onAddAgent(space)}>
            {t('spaces.addAgent')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onPress={() => onDelete(space)}>
          {t('spaces.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
