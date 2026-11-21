-- a scheduled delivery once stored its model text, [CRON REMINDER name]: text, as the text people see
UPDATE `memories` SET `message` = substr(`message`, instr(`message`, ']: ') + 3)
WHERE json_extract(`modelMessage`, '$.model') = 'scheduled-delivery'
	AND `message` = json_extract(`modelMessage`, '$.content[0].text')
	AND `message` LIKE '[CRON %';
