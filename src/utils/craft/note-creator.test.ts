import { beforeEach, describe, expect, test, vi } from 'vitest';
import { defaultCraftSettings } from '../storage-utils';
import { saveToCraft } from './note-creator';
import * as client from './client';

vi.mock('./client', async () => {
	const actual = await vi.importActual<typeof import('./client')>('./client');
	return { ...actual, craftSave: vi.fn() };
});

const mockedSave = vi.mocked(client.craftSave);

const craft = { ...defaultCraftSettings, apiUrl: 'https://connect.craft.do/links/test/api/v1' };

function lastMarkdown(): string {
	expect(mockedSave).toHaveBeenCalled();
	const payload = mockedSave.mock.calls[0][0];
	return payload.markdown;
}

describe('saveToCraft', () => {
	beforeEach(() => {
		mockedSave.mockReset();
		mockedSave.mockResolvedValue({ documentId: 'doc-1', clickableLink: 'craftdocs://open' });
	});

	test('checkbox booleans from the popup DOM do not throw before the API call', async () => {
		await expect(saveToCraft({
			title: 'A clip',
			body: 'Hello',
			properties: [
				{ name: 'starred', value: true as unknown as string },
				{ name: 'archived', value: false as unknown as string },
			],
			folderId: null,
			craft,
		})).resolves.toEqual({ documentId: 'doc-1', clickableLink: 'craftdocs://open' });

		expect(mockedSave).toHaveBeenCalledOnce();
		expect(lastMarkdown()).toContain('<callout>**starred**: true</callout>');
		expect(lastMarkdown()).not.toContain('archived');
	});

	test('does not leave an image inline inside a property callout', async () => {
		await saveToCraft({
			title: 'A clip',
			body: 'Hello',
			properties: [
				{ name: 'image', value: '![cover](https://ex.com/cover.png)' },
			],
			folderId: null,
			craft,
		});

		const markdown = lastMarkdown();
		expect(markdown).not.toMatch(/: !\[[^\]]*\]\([^)]+\)/);
		expect(markdown).toContain('[cover](https://ex.com/cover.png)');
	});

	test('linked images in the body become block images before save', async () => {
		await saveToCraft({
			title: 'A clip',
			body: 'Intro [![shot](https://ex.com/a.png)](https://ex.com/post) outro',
			properties: [],
			folderId: null,
			craft,
		});

		const markdown = lastMarkdown();
		expect(markdown).toContain('![shot](https://ex.com/a.png)');
		expect(markdown).not.toContain('[![shot]');
		expect(markdown).not.toMatch(/Intro !\[shot\]/);
	});
});
