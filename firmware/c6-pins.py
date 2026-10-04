# ESP32-C6-WROOM/DevKit pin mapping. GPIO24..30 connect to module flash.
# Espruino pin symbols Dn map to GPIO n. USB Serial/JTAG is GPIO12/13.
devices = {}
def get_pins():
    pins = pinutils.generate_pins(0, 23)
    for i in range(7):
        pinutils.findpin(pins, 'PD' + str(i), True)['functions']['ADC1_IN' + str(i)] = 0
    functions = {12: 'USB', 13: 'USB', 16: 'USART1_TX', 17: 'USART1_RX',
                 6: 'I2C1_SCL', 7: 'I2C1_SDA',
                 21: 'SPI1_SCK', 20: 'SPI1_MOSI', 19: 'SPI1_MISO'}
    for n, function in functions.items():
        pinutils.findpin(pins, 'PD' + str(n), True)['functions'][function] = 0
    for pin in pins:
        pin['functions']['3.3'] = 0
    return pins
